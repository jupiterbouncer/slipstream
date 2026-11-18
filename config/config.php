<?php
/**
 * Slipstream Configuration Loader
 * Handles database credentials and application settings.
 * Precedence: Environment variables > config.local.php > default config.
 */

$defaults = [
    'db' => [
        'host' => '127.0.0.1',
        'port' => 3306,
        'dbname' => 'slipstream',
        'user' => 'root',
        'pass' => '',
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

$deployed = in_array(getenv('APP_ENV'), ['staging', 'production'], true) || getenv('RAILWAY_ENVIRONMENT_ID') !== false;
$missing = [];
foreach (['DB_HOST' => 'host', 'DB_PORT' => 'port', 'DB_NAME' => 'dbname', 'DB_USER' => 'user', 'DB_PASS' => 'pass'] as $variable => $key) {
    $value = getenv($variable);
    if ($value !== false) {
        $defaults['db'][$key] = $value;
    }
    if ($deployed && ($value === false || $value === '')) {
        $missing[] = $variable;
    }
}
if ($missing) {
    error_log('Slipstream missing database variables: ' . implode(', ', $missing));
    throw new RuntimeException('Incomplete database configuration.');
}
$port = filter_var($defaults['db']['port'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
if ($port === false) {
    error_log('Slipstream DB_PORT must be an integer from 1 to 65535.');
    throw new RuntimeException('Invalid database configuration.');
}
$defaults['db']['port'] = $port;
return $defaults;
