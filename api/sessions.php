<?php
/**
 * Slipstream Signaling REST API
 * Handles WebRTC session negotiation (§5, §6).
 * File bytes NEVER touch this service.
 */

declare(strict_types=1);

require_once __DIR__ . '/db.php';

// Enable CORS for local network and dev environments
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept, X-Requested-With');

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

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
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        $ips = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($ips[0]);
    }
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

// Normalize path: strip script name or base directory if called directly
// e.g. /sessions, /sessions/ABCDEF, /sessions/ABCDEF/offer
$path = $requestUri;
if (strpos($path, '/api/sessions.php') !== false) {
    $path = substr($path, strpos($path, '/api/sessions.php') + strlen('/api/sessions.php'));
} elseif (strpos($path, '/sessions') !== false) {
    $path = substr($path, strpos($path, '/sessions'));
}

// Remove trailing slash
$path = rtrim($path, '/');
if ($path === '') {
    $path = '/sessions';
}

$segments = explode('/', trim($path, '/'));
// Expect:
// ['sessions']
// ['sessions', '{code}']
// ['sessions', '{code}', 'offer']
// ['sessions', '{code}', 'answer']
// ['sessions', '{code}', 'ice-candidates']

if (empty($segments) || $segments[0] !== 'sessions') {
    sendJson(404, ['error' => 'Not Found']);
}

$pdo = getDbConnection();
runLazyCleanup($pdo);
$clientIp = getClientIp();

// Read input JSON for POST requests
$rawInput = file_get_contents('php://input');
$jsonBody = [];
if ($rawInput !== '' && $rawInput !== false) {
    $jsonBody = json_decode($rawInput, true);
    if (!is_array($jsonBody) && in_array($requestMethod, ['POST', 'PUT', 'PATCH'], true)) {
        sendJson(400, ['error' => 'Invalid JSON body']);
    }
}

// -----------------------------------------------------------------------------
// Route 1: POST /sessions (Create a new pairing session)
// -----------------------------------------------------------------------------
if (count($segments) === 1 && $requestMethod === 'POST') {
    $config = require __DIR__ . '/../config/config.php';
    $expiryMinutes = $config['session']['expiry_minutes'] ?? 10;
    $codeLength = $config['session']['code_length'] ?? 6;

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

// -----------------------------------------------------------------------------
// Route 2: GET /sessions/{code} (Validate session)
// Route 3: DELETE /sessions/{code} (Clean up session)
// -----------------------------------------------------------------------------
if (count($segments) === 2) {
    if ($requestMethod === 'GET') {
        if (isRateLimited($pdo, $clientIp)) {
            sendJson(429, ['error' => 'Too many failed code validation attempts. Please wait.']);
        }

        $session = getActiveSession($pdo, $code);
        if (!$session) {
            recordFailedAttempt($pdo, $clientIp);
            sendJson(404, ['error' => 'Session not found or expired']);
        }

        clearRateLimit($pdo, $clientIp);
        $expiresAtIso = gmdate('Y-m-d\TH:i:s\Z', strtotime($session['expires_at']));
        $createdAtIso = gmdate('Y-m-d\TH:i:s\Z', strtotime($session['created_at']));

        sendJson(200, [
            'code' => $session['code'],
            'expiresAt' => $expiresAtIso,
            'createdAt' => $createdAtIso,
        ]);
    }

    if ($requestMethod === 'DELETE') {
        $stmt = $pdo->prepare('DELETE FROM sessions WHERE code = :code');
        $stmt->execute([':code' => $code]);
        sendNoContent();
    }

    sendJson(405, ['error' => 'Method Not Allowed']);
}

$subResource = $segments[2];

// -----------------------------------------------------------------------------
// Route 4: POST /sessions/{code}/offer (Host submits SDP offer)
// Route 5: GET /sessions/{code}/offer (Joiner polls for SDP offer)
// -----------------------------------------------------------------------------
if ($subResource === 'offer') {
    $session = getActiveSession($pdo, $code);
    if (!$session) {
        sendJson(404, ['error' => 'Session not found or expired']);
    }

    if ($requestMethod === 'POST') {
        // Offer body should contain SDP
        $offer = $jsonBody['offer'] ?? $jsonBody;
        if (empty($offer) || empty($offer['sdp']) || ($offer['type'] ?? '') !== 'offer') {
            sendJson(400, ['error' => 'Invalid SDP offer payload. Must include sdp and type="offer".']);
        }

        $stmt = $pdo->prepare('UPDATE sessions SET offer_sdp = :sdp WHERE code = :code');
        $stmt->execute([
            ':sdp' => json_encode($offer, JSON_UNESCAPED_SLASHES),
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
    $session = getActiveSession($pdo, $code);
    if (!$session) {
        sendJson(404, ['error' => 'Session not found or expired']);
    }

    if ($requestMethod === 'POST') {
        $answer = $jsonBody['answer'] ?? $jsonBody;
        if (empty($answer) || empty($answer['sdp']) || ($answer['type'] ?? '') !== 'answer') {
            sendJson(400, ['error' => 'Invalid SDP answer payload. Must include sdp and type="answer".']);
        }

        $stmt = $pdo->prepare('UPDATE sessions SET answer_sdp = :sdp WHERE code = :code');
        $stmt->execute([
            ':sdp' => json_encode($answer, JSON_UNESCAPED_SLASHES),
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
    $session = getActiveSession($pdo, $code);
    if (!$session) {
        sendJson(404, ['error' => 'Session not found or expired']);
    }

    if ($requestMethod === 'POST') {
        $role = $jsonBody['role'] ?? '';
        $candidate = $jsonBody['candidate'] ?? null;

        if (!in_array($role, ['host', 'joiner'], true)) {
            sendJson(400, ['error' => 'Invalid role. Must be "host" or "joiner".']);
        }

        if (empty($candidate)) {
            sendJson(400, ['error' => 'Missing candidate payload.']);
        }

        $column = $role === 'host' ? 'host_ice_candidates' : 'joiner_ice_candidates';
        $currentList = !empty($session[$column]) ? json_decode($session[$column], true) : [];
        if (!is_array($currentList)) {
            $currentList = [];
        }

        $currentList[] = $candidate;

        $stmt = $pdo->prepare("UPDATE sessions SET {$column} = :candidates WHERE code = :code");
        $stmt->execute([
            ':candidates' => json_encode($currentList, JSON_UNESCAPED_SLASHES),
            ':code' => $code,
        ]);

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
