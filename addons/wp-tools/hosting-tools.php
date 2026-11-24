<?php
/*
 * Plugin Name: Hosting Tools
 * Description: Automated management and security for WordPress.
 */
defined('ABSPATH') || exit;
if (is_file(__DIR__ . '/hosting-tools/sign-in.php')) include __DIR__ . '/hosting-tools/sign-in.php';
if (is_file(__DIR__ . '/hosting-tools/guard.php')) include __DIR__ . '/hosting-tools/guard.php';
