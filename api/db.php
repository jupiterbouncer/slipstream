<?php
/**
 * Database connection and persistence helpers for Slipstream.
 * Ensures strict prepared statements, secure credentials handling, and lazy cleanup.
 */

declare(strict_types=1);

function getDbConnection(): PDO {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $config = require __DIR__ . '/../config/config.php';
    $db = $config['db'];

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'],
        $db['port'],
        $db['dbname'],
        $db['charset']
    );

    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false, // Always use native prepared statements
    ];

    try {
        $pdo = new PDO($dsn, $db['user'], $db['pass'], $options);
        $pdo->exec("SET time_zone = '+00:00'");
    } catch (PDOException $e) {
        error_log('Slipstream database connection failed. Check DB variables and private networking. Error code ' . $e->getCode());
        throw new RuntimeException('Database connection failed.');
    }

    return $pdo;
}

/**
 * Lazily clean up expired sessions and outdated rate-limit records (§6, §7).
 */
function runLazyCleanup(PDO $pdo): void {
    try {
        // 1. Delete sessions whose pairing window has expired
        $stmt = $pdo->prepare('DELETE FROM sessions WHERE expires_at < NOW()');
        $stmt->execute();

        // 2. Delete rate limit rows older than 15 minutes
        $stmt = $pdo->prepare('DELETE FROM rate_limits WHERE last_attempt_at < (NOW() - INTERVAL 15 MINUTE)');
        $stmt->execute();
    } catch (Exception $e) {
        // Cleanup errors should not interrupt the main request flow
        error_log('Slipstream lazy cleanup error: ' . $e->getCode());
    }
}

/**
 * Check if the caller IP is temporarily rate-limited (§6, §7).
 * Uses SHA-256 hash of IP to prevent tracking or retaining personal profile data.
 */
function isRateLimited(PDO $pdo, string $ip): bool {
    $config = require __DIR__ . '/../config/config.php';
    $maxAttempts = $config['rate_limit']['max_attempts'] ?? 10;
    $windowSeconds = $config['rate_limit']['window_seconds'] ?? 60;

    $ipHash = hash('sha256', $ip . '_slipstream_salt');

    $stmt = $pdo->prepare('
        SELECT failed_attempts, last_attempt_at 
        FROM rate_limits 
        WHERE ip_hash = :hash
    ');
    $stmt->execute([':hash' => $ipHash]);
    $row = $stmt->fetch();

    if (!$row) {
        return false;
    }

    $lastAttempt = strtotime($row['last_attempt_at'] . ' UTC');
    if (time() - $lastAttempt > $windowSeconds) {
        // Window expired, reset
        $clearStmt = $pdo->prepare('DELETE FROM rate_limits WHERE ip_hash = :hash');
        $clearStmt->execute([':hash' => $ipHash]);
        return false;
    }

    return (int)$row['failed_attempts'] >= $maxAttempts;
}

/**
 * Record a failed pairing code lookup for rate limiting.
 */
function recordFailedAttempt(PDO $pdo, string $ip): void {
    $ipHash = hash('sha256', $ip . '_slipstream_salt');

    $stmt = $pdo->prepare('
        INSERT INTO rate_limits (ip_hash, failed_attempts, last_attempt_at)
        VALUES (:hash, 1, NOW())
        ON DUPLICATE KEY UPDATE 
            failed_attempts = failed_attempts + 1,
            last_attempt_at = NOW()
    ');
    $stmt->execute([':hash' => $ipHash]);
}
