-- Slipstream MySQL Database Schema
-- Table for temporary WebRTC signaling metadata
-- File bytes NEVER touch this database.

CREATE DATABASE IF NOT EXISTS slipstream CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE slipstream;

-- Sessions table as specified in Slipstream Technical Specification §6
CREATE TABLE IF NOT EXISTS sessions (
  code VARCHAR(10) PRIMARY KEY,
  offer_sdp TEXT NULL,
  answer_sdp TEXT NULL,
  host_ice_candidates JSON NULL,
  joiner_ice_candidates JSON NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limits table to prevent brute-force guessing of pairing codes (§6, §7)
-- Uses SHA-256 hash of IP address to protect privacy.
-- Rows are automatically purged after the rate-limit window.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash VARCHAR(64) PRIMARY KEY,
  failed_attempts INT NOT NULL DEFAULT 1,
  last_attempt_at DATETIME NOT NULL,
  INDEX idx_last_attempt (last_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
