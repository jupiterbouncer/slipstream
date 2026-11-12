<?php
/**
 * Slipstream Configuration Loader
 * Handles database credentials and application settings.
 * Precedence: Environment variables > config.local.php > default config.
 */

$defaults = [
    'db' => [
        'host' => getenv('DB_HOST') ?: '127.0.0.1',
        'port' => (int)(getenv('DB_PORT') ?: 3306),
        'dbname' => getenv('DB_NAME') ?: 'slipstream',
        'user' => getenv('DB_USER') ?: 'root',
        'pass' => getenv('DB_PASS') !== false ? getenv('DB_PASS') : 'mysql',
        'charset' => 'utf8mb4',
    ],
    'session' => [
        'expiry_minutes' => 10,
        'code_length' => 6,
    ],
    'rate_limit' => [
        'max_attempts' => 10,
        'window_seconds' => 60,
    ],
];

// Check for local overrides (which are git-ignored)
$localConfigPath = __DIR__ . '/config.local.php';
if (!file_exists($localConfigPath)) {
    $localConfigPath = __DIR__ . '/local.php';
}

if (file_exists($localConfigPath)) {
    $localConfig = require $localConfigPath;
    if (is_array($localConfig)) {
        $defaults = array_replace_recursive($defaults, $localConfig);
    }
}

return $defaults;
