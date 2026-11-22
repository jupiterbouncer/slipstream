<?php
/**
 * Slipstream Signaling REST API
 * Handles WebRTC session negotiation (§5, §6).
 * File bytes NEVER touch this service.
 */

declare(strict_types=1);

require_once __DIR__ . '/db.php';

// This API serves the browser on the same origin as the application.
ini_set('display_errors', '0');
date_default_timezone_set('UTC');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
set_exception_handler(static function (Throwable $error): void {
    error_log('Slipstream signaling failure: ' . get_class($error));
    sendJson(500, ['error' => 'Signaling service unavailable']);
});

// Ensure clean JSON responses
function sendJson(int $statusCode, array $data): void {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function sendNoContent(): void {
    http_response_code(204);
    exit;
}

// Extract client IP address for temporary rate limiting (§6, §7)
function getClientIp(): string {
    return $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';
}

// Generate a random, unambiguous pairing code (e.g. 6 chars, uppercase, no 0/O, 1/I)
function generatePairingCode(PDO $pdo, int $length = 6): string {
    // Character set without easily confused characters
    $chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    $charsLen = strlen($chars);

    for ($attempt = 0; $attempt < 10; $attempt++) {
        $code = '';
        $bytes = random_bytes($length);
        for ($i = 0; $i < $length; $i++) {
            $code .= $chars[ord($bytes[$i]) % $charsLen];
        }

        // Check if code is already in use
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM sessions WHERE code = :code');
        $stmt->execute([':code' => $code]);
        if ((int)$stmt->fetchColumn() === 0) {
            return $code;
        }
    }

    throw new RuntimeException('Failed to generate unique pairing code');
}

// Parse request path and method
$requestMethod = $_SERVER['REQUEST_METHOD'];
$requestUri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '/';

$segments = explode('/', trim($requestUri, '/'));
if ($segments[0] !== 'sessions' || count($segments) > 3) {
    sendJson(404, ['error' => 'Not Found']);
}
if (!in_array($requestMethod, ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    sendJson(405, ['error' => 'Method Not Allowed']);
}
if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') {
    sendJson(403, ['error' => 'Open Slipstream to use this endpoint']);
}

$pdo = getDbConnection();
runLazyCleanup($pdo);
$clientIp = getClientIp();

// Read input JSON for POST requests
$rawInput = file_get_contents('php://input');
$jsonBody = [];
if ($rawInput !== '' && $rawInput !== false) {
    $jsonBody = json_decode($rawInput, true);
    if (!is_array($jsonBody) && $requestMethod === 'POST') {
        sendJson(400, ['error' => 'Invalid JSON body']);
    }
}

// -----------------------------------------------------------------------------
// Route 1: POST /sessions (Create a new pairing session)
// -----------------------------------------------------------------------------
if (count($segments) === 1 && $requestMethod === 'POST') {
    if ($jsonBody !== []) sendJson(400, ['error' => 'Session creation takes no parameters']);
    $config = require __DIR__ . '/../config/config.php';
    $expiryMinutes = $config['session']['expiry_minutes'] ?? 10;
    $codeLength = $config['session']['code_length'] ?? 6;

    if (!allowSessionCreation($pdo, $clientIp, $config['rate_limit'])) {
        sendJson(429, ['error' => 'Too many new sessions. Please wait before pairing again.']);
    }
    $code = generatePairingCode($pdo, $codeLength);
    $expiresAtTime = time() + ($expiryMinutes * 60);
    $expiresAtSql = date('Y-m-d H:i:s', $expiresAtTime);
    $expiresAtIso = gmdate('Y-m-d\TH:i:s\Z', $expiresAtTime);

    $stmt = $pdo->prepare('
        INSERT INTO sessions (code, created_at, expires_at)
        VALUES (:code, NOW(), :expires_at)
    ');
    $stmt->execute([
        ':code' => $code,
        ':expires_at' => $expiresAtSql,
    ]);

    sendJson(201, [
        'code' => $code,
        'expiresAt' => $expiresAtIso,
    ]);
}

// Code validation for sub-routes
if (count($segments) < 2) {
    sendJson(405, ['error' => 'Method Not Allowed']);
}

$code = strtoupper(trim($segments[1]));
// Validate format: 4 to 10 alphanumeric characters
if (!preg_match('/^[A-Z0-9]{4,10}$/', $code)) {
    sendJson(400, ['error' => 'Invalid pairing code format']);
}

// Helper to retrieve an active (non-expired) session
function getActiveSession(PDO $pdo, string $code): ?array {
    $stmt = $pdo->prepare('
        SELECT code, offer_sdp, answer_sdp, host_ice_candidates, joiner_ice_candidates, created_at, expires_at
        FROM sessions
        WHERE code = :code AND expires_at > NOW()
    ');
    $stmt->execute([':code' => $code]);
    $row = $stmt->fetch();
    return $row ?: null;
}

function requireActiveSession(PDO $pdo, string $ip, string $code): array {
    if (isRateLimited($pdo, $ip)) {
        sendJson(429, ['error' => 'Too many failed code attempts. Please wait.']);
    }
    $session = getActiveSession($pdo, $code);
    if (!$session) {
        recordFailedAttempt($pdo, $ip);
        sendJson(404, ['error' => 'Session not found or expired']);
    }
    return $session;
}

// -----------------------------------------------------------------------------
// Route 2: GET /sessions/{code} (Validate session)
// Route 3: POST /sessions/{code}/delete (Clean up session)
// -----------------------------------------------------------------------------
if (count($segments) === 2) {
    if ($requestMethod === 'GET') {
        $session = requireActiveSession($pdo, $clientIp, $code);
        clearRateLimit($pdo, $clientIp);
        $expiresAtIso = gmdate('Y-m-d\TH:i:s\Z', strtotime($session['expires_at']));
        $createdAtIso = gmdate('Y-m-d\TH:i:s\Z', strtotime($session['created_at']));

        sendJson(200, [
            'code' => $session['code'],
            'expiresAt' => $expiresAtIso,
            'createdAt' => $createdAtIso,
        ]);
    }

    sendJson(405, ['error' => 'Method Not Allowed']);
}

$subResource = $segments[2];
if ($subResource === 'delete') {
    if ($requestMethod !== 'POST') {
        header('Allow: POST');
        sendJson(405, ['error' => 'Use POST for session cleanup']);
    }
    // The browser sends an empty JSON object. No generic actions or form posts.
    $contentType = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    if ($contentType !== 'application/json' || !is_object(json_decode($rawInput)) || $jsonBody !== [] || $_GET) {
        sendJson(400, ['error' => 'Expected an empty JSON object']);
    }
    $stmt = $pdo->prepare('DELETE FROM sessions WHERE code = :code');
    $stmt->execute([':code' => $code]);
    sendNoContent();
}

// -----------------------------------------------------------------------------
// Route 4: POST /sessions/{code}/offer (Host submits SDP offer)
// Route 5: GET /sessions/{code}/offer (Joiner polls for SDP offer)
// -----------------------------------------------------------------------------
if ($subResource === 'offer') {
    $session = requireActiveSession($pdo, $clientIp, $code);

    if ($requestMethod === 'POST') {
        // Offer body should contain SDP
        $offer = $jsonBody['offer'] ?? $jsonBody;
        if (!is_string($offer['sdp'] ?? null) || $offer['sdp'] === '' || strlen($offer['sdp']) > 60000 || ($offer['type'] ?? '') !== 'offer') {
            sendJson(400, ['error' => 'Invalid SDP offer payload. Must include sdp and type="offer".']);
        }

        $stmt = $pdo->prepare('UPDATE sessions SET offer_sdp = :sdp WHERE code = :code');
        $stmt->execute([
            ':sdp' => json_encode(['type' => 'offer', 'sdp' => $offer['sdp']], JSON_UNESCAPED_SLASHES),
            ':code' => $code,
        ]);

        sendJson(200, ['status' => 'ok']);
    }

    if ($requestMethod === 'GET') {
        if (empty($session['offer_sdp'])) {
            // As per §5: 204 No Content while pending
            sendNoContent();
        }

        $offer = json_decode($session['offer_sdp'], true);
        sendJson(200, ['offer' => $offer]);
    }

    sendJson(405, ['error' => 'Method Not Allowed']);
}

// -----------------------------------------------------------------------------
// Route 6: POST /sessions/{code}/answer (Joiner submits SDP answer)
// Route 7: GET /sessions/{code}/answer (Host polls for SDP answer)
// -----------------------------------------------------------------------------
if ($subResource === 'answer') {
    $session = requireActiveSession($pdo, $clientIp, $code);

    if ($requestMethod === 'POST') {
        $answer = $jsonBody['answer'] ?? $jsonBody;
        if (!is_string($answer['sdp'] ?? null) || $answer['sdp'] === '' || strlen($answer['sdp']) > 60000 || ($answer['type'] ?? '') !== 'answer') {
            sendJson(400, ['error' => 'Invalid SDP answer payload. Must include sdp and type="answer".']);
        }

        $stmt = $pdo->prepare('UPDATE sessions SET answer_sdp = :sdp WHERE code = :code');
        $stmt->execute([
            ':sdp' => json_encode(['type' => 'answer', 'sdp' => $answer['sdp']], JSON_UNESCAPED_SLASHES),
            ':code' => $code,
        ]);

        sendJson(200, ['status' => 'ok']);
    }

    if ($requestMethod === 'GET') {
        if (empty($session['answer_sdp'])) {
            sendNoContent();
        }

        $answer = json_decode($session['answer_sdp'], true);
        sendJson(200, ['answer' => $answer]);
    }

    sendJson(405, ['error' => 'Method Not Allowed']);
}

// -----------------------------------------------------------------------------
// Route 8: POST /sessions/{code}/ice-candidates (Submit ICE candidate)
// Route 9: GET /sessions/{code}/ice-candidates?role=host|joiner (Retrieve candidates)
// -----------------------------------------------------------------------------
if ($subResource === 'ice-candidates') {
    $session = requireActiveSession($pdo, $clientIp, $code);

    if ($requestMethod === 'POST') {
        $role = $jsonBody['role'] ?? '';
        $candidate = $jsonBody['candidate'] ?? null;

        if (!in_array($role, ['host', 'joiner'], true)) {
            sendJson(400, ['error' => 'Invalid role. Must be "host" or "joiner".']);
        }

        if (!is_array($candidate) || !is_string($candidate['candidate'] ?? null) || strlen($candidate['candidate']) > 4096) {
            sendJson(400, ['error' => 'Missing candidate payload.']);
        }

        $column = $role === 'host' ? 'host_ice_candidates' : 'joiner_ice_candidates';
        $candidate = array_intersect_key($candidate, array_flip(['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']));
        foreach (['sdpMid', 'usernameFragment'] as $key) {
            if (isset($candidate[$key]) && (!is_string($candidate[$key]) || strlen($candidate[$key]) > 256)) {
                sendJson(400, ['error' => 'Invalid ICE candidate field']);
            }
        }
        if (isset($candidate['sdpMLineIndex']) && !is_int($candidate['sdpMLineIndex'])) {
            sendJson(400, ['error' => 'Invalid ICE media index']);
        }
        // Append in the database so concurrent candidate POSTs do not overwrite one another.
        $stmt = $pdo->prepare("UPDATE sessions SET {$column} =
            JSON_ARRAY_APPEND(COALESCE({$column}, JSON_ARRAY()), '$', JSON_EXTRACT(:candidate, '$'))
            WHERE code = :code AND expires_at > NOW()");
        $stmt->execute([':candidate' => json_encode($candidate), ':code' => $code]);
        if ($stmt->rowCount() !== 1) {
            sendJson(404, ['error' => 'Session not found or expired']);
        }

        sendJson(200, ['status' => 'ok']);
    }

    if ($requestMethod === 'GET') {
        // Crucial requirement from §5 & §108:
        // "role means the role whose candidates the caller wants to retrieve.
        // Therefore, the host asks for role=joiner, and the joiner asks for role=host."
        $role = $_GET['role'] ?? '';
        if (!in_array($role, ['host', 'joiner'], true)) {
            sendJson(400, ['error' => 'Role parameter required ("host" or "joiner") representing whose candidates to fetch.']);
        }

        $column = $role === 'host' ? 'host_ice_candidates' : 'joiner_ice_candidates';
        $candidates = !empty($session[$column]) ? json_decode($session[$column], true) : [];
        if (!is_array($candidates)) {
            $candidates = [];
        }

        // Support optional cursor ?after=N to fetch only candidates after index N
        if (isset($_GET['after']) && is_numeric($_GET['after'])) {
            $afterIndex = (int)$_GET['after'];
            if ($afterIndex >= 0 && $afterIndex < count($candidates)) {
                $candidates = array_slice($candidates, $afterIndex);
            } elseif ($afterIndex >= count($candidates)) {
                $candidates = [];
            }
        }

        sendJson(200, [
            'role' => $role,
            'candidates' => $candidates,
        ]);
    }

    sendJson(405, ['error' => 'Method Not Allowed']);
}

// Any other sub-resource
sendJson(404, ['error' => 'Unknown endpoint']);
