<?php
/**
 * Slipstream QA — CLI Test-File Generator
 * Generates boundary test fixtures for WebRTC data-channel transfer testing (§3, §10).
 * Calculates and records SHA-256 hashes for integrity verification.
 *
 * Usage: php qa/generate-test-files.php [output_dir]
 */

$outputDir = isset($argv[1]) ? $argv[1] : __DIR__ . '/fixtures';
if (!is_dir($outputDir)) {
    mkdir($outputDir, 0777, true);
}

echo "=== Slipstream Phase 2 Test-File Generator ===\n";
echo "Output directory: {$outputDir}\n\n";

$CHUNK_SIZE = 16384; // 16 KiB as per §3.2

$testSpecs = [
    [
        'name' => 'test_0b.bin',
        'size' => 0,
        'description' => '0-byte empty file (Protocol edge case, totalChunks: 0)'
    ],
    [
        'name' => 'test_1b.bin',
        'size' => 1,
        'description' => '1-byte file (Single chunk: 1 byte)'
    ],
    [
        'name' => 'test_16383b.bin',
        'size' => 16383,
        'description' => '16,383 bytes (Chunk boundary minus 1 byte; single chunk)'
    ],
    [
        'name' => 'test_16384b.bin',
        'size' => 16384,
        'description' => '16,384 bytes (Exact 16 KiB chunk boundary; single chunk)'
    ],
    [
        'name' => 'test_16385b.bin',
        'size' => 16385,
        'description' => '16,385 bytes (Chunk boundary plus 1 byte; exactly 2 chunks: 16,384 + 1)'
    ],
    [
        'name' => 'test_32768b.bin',
        'size' => 32768,
        'description' => '32,768 bytes (Exact 2 full chunks: 2 x 16,384)'
    ],
    [
        'name' => 'test_65536b.bin',
        'size' => 65536,
        'description' => '65,536 bytes (Exact 4 full chunks)'
    ],
    [
        'name' => 'test_1mb.bin',
        'size' => 1048576, // 1 MiB
        'description' => '1,048,576 bytes (1 MiB; 64 chunks)'
    ],
    [
        'name' => 'test_5mb.bin',
        'size' => 5242880, // 5 MiB
        'description' => '5,242,880 bytes (5 MiB; 320 chunks)'
    ],
    [
        'name' => 'test_10mb.bin',
        'size' => 10485760, // 10 MiB
        'description' => '10,485,760 bytes (10 MiB; 640 chunks)'
    ]
];

$manifest = [
    'generatedAt' => date('c'),
    'protocolVersion' => 1,
    'chunkSize' => $CHUNK_SIZE,
    'files' => []
];

foreach ($testSpecs as $spec) {
    $filePath = $outputDir . '/' . $spec['name'];
    $size = $spec['size'];
    $fp = fopen($filePath, 'wb');

    if ($size > 0) {
        $remaining = $size;
        $pattern = '';
        // Deterministic repeating pattern 0x00 to 0xFF for reproducible verification
        for ($i = 0; $i < 256; $i++) {
            $pattern .= chr($i);
        }
        $patternLen = strlen($pattern);

        while ($remaining > 0) {
            $writeSize = min($remaining, 65536);
            $chunk = '';
            while (strlen($chunk) < $writeSize) {
                $needed = $writeSize - strlen($chunk);
                $chunk .= substr($pattern, 0, min($needed, $patternLen));
            }
            fwrite($fp, $chunk);
            $remaining -= $writeSize;
        }
    }
    fclose($fp);

    $hash = hash_file('sha256', $filePath);
    $totalChunks = $size === 0 ? 0 : (int)ceil($size / $CHUNK_SIZE);
    $finalChunkSize = $size === 0 ? 0 : ($size % $CHUNK_SIZE === 0 ? $CHUNK_SIZE : $size % $CHUNK_SIZE);

    $entry = [
        'filename' => $spec['name'],
        'description' => $spec['description'],
        'sizeBytes' => $size,
        'formattedSize' => formatBytes($size),
        'chunkSize' => $CHUNK_SIZE,
        'totalChunks' => $totalChunks,
        'finalChunkSize' => $finalChunkSize,
        'sha256' => $hash,
        'path' => $filePath
    ];

    $manifest['files'][] = $entry;

    printf("[%-16s] %10s (%2d chunks) -> SHA-256: %s\n", 
        $spec['name'], 
        formatBytes($size), 
        $totalChunks, 
        $hash
    );
}

$manifestPath = $outputDir . '/manifest.json';
file_put_contents($manifestPath, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
echo "\nManifest written to: {$manifestPath}\n";

// Also write a standard sha256sums.txt file for easy `sha256sum -c` verification
$sumsTxt = "";
foreach ($manifest['files'] as $f) {
    $sumsTxt .= "{$f['sha256']}  {$f['filename']}\n";
}
file_put_contents($outputDir . '/sha256sums.txt', $sumsTxt);
echo "Checksums written to: {$outputDir}/sha256sums.txt\n";
echo "Done! All test fixtures generated successfully.\n";

function formatBytes($bytes) {
    if ($bytes === 0) return '0 B';
    $units = ['B', 'KB', 'MB', 'GB'];
    $i = floor(log($bytes, 1024));
    return round($bytes / pow(1024, $i), 2) . ' ' . $units[$i];
}
