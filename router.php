<?php
/**
 * Slipstream Local Development Router
 * For use with PHP's built-in web server:
 * php -S 0.0.0.0:8000 router.php
 */

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Block direct access to sensitive config, schema, or hidden files
if (
    preg_match('#^/(config|database|\.git|\.env)#i', $uri) ||
    preg_match('#\.(sql|log|md|example|gitignore)$#i', $uri)
) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}

// Route /sessions API endpoints
if (preg_match('#^/sessions#', $uri)) {
    require __DIR__ . '/api/sessions.php';
    exit;
}

// If requesting an existing file in the directory (css, js, html, images), serve it directly
$filePath = __DIR__ . $uri;
if ($uri !== '/' && file_exists($filePath) && !is_dir($filePath)) {
    return false; // Built-in server will serve the file with correct MIME type
}

// Otherwise serve the main single-page application
require __DIR__ . '/index.html';
