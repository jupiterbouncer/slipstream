<?php
// Run from the CLI in the same private network as MySQL.
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../api/db.php';

try {
    $pdo = getDbConnection();
    $sql = file_get_contents(__DIR__ . '/schema.sql');
    if ($sql === false) {
        throw new RuntimeException('Schema file is unavailable.');
    }
    $pdo->exec($sql);
    echo "Signaling schema is ready (sessions and rate_limits).\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Could not initialize signaling schema. Check DB variables, MySQL availability and CREATE privileges. Error code ' . $error->getCode() . PHP_EOL);
    exit(1);
}
