<?php
declare(strict_types=1);

// Generate a fresh upload directory. Never merge into a previous release that
// might contain private credentials or files from an older deployment.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
$root = dirname(__DIR__);
$target = $root . '/build/infinityfree/' . gmdate('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '/htdocs';
$assets = [
    '.htaccess', 'index.html', 'slipstream-favicon.svg', 'css/style.css',
    'js/scanner.js', 'js/vendor/jsQR.js', 'js/vendor/jsQR.LICENSE.txt', 'js/vendor/qrcode.LICENSE.txt',
    'js/file-requests.js',
    'js/file-queue.js', 'js/file-viewer.js', 'js/share-text.js',
    'js/session.js', 'js/application-messages.js',
    'js/turn-config.js', 'js/turn.js',
    'js/api.js', 'js/webrtc.js', 'js/transfer-protocol.js', 'js/file-sender.js',
    'js/file-receiver.js', 'js/app.js', 'js/ui-motion.js', 'js/vendor/qrcode.min.js',
    'api/db.php', 'api/sessions.php', 'config/.htaccess', 'config/config.php',
];
foreach ($assets as $asset) {
    $dir = dirname($target . '/' . $asset);
    if (!is_dir($dir) && !mkdir($dir, 0755, true)) {
        throw new RuntimeException('Cannot create package directory.');
    }
    if (!copy($root . '/' . $asset, $target . '/' . $asset)) {
        throw new RuntimeException('Cannot package ' . $asset);
    }
}
echo $target, PHP_EOL;
