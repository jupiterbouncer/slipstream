<?php
/**
 * Slipstream Configuration Template
 * Copy this file to config.local.php to override defaults with your local MySQL credentials.
 */

return [
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'dbname' => 'slipstream',
        'user' => 'root',
        'pass' => 'replace-with-your-local-password', // Default for AMPPS is 'mysql'. For XAMPP it is often empty ''.
        'charset' => 'utf8mb4',
    ],
    'session' => [
        'expiry_minutes' => 10, // Pairing code validity window (§6)
        'code_length' => 6,     // Length of short pairing code
    ],
    'rate_limit' => [
        'max_attempts' => 10,   // Max failed lookups before temporary block
        'window_seconds' => 60, // Window in seconds
    ],
];
