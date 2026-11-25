<?php
// Runs inside `wp eval` as the site's own user, with plugins, themes and WP-CLI
// packages skipped. The request is JSON on stdin and the reply one marked line;
// a failure replies with a code, which the addon turns into its own message.

const CLP_MAINWP_CHILD = 'mainwp-child/mainwp-child.php';
const CLP_MAINWP_LOADER = 'wp-content/mu-plugins/hosting-tools.php';
const CLP_MAINWP_MODULES = 'wp-content/mu-plugins/hosting-tools';
const CLP_MAINWP_GUARD = 'wp-content/mu-plugins/hosting-tools/guard.php';
const CLP_MAINWP_SIGN_IN = 'wp-content/mu-plugins/hosting-tools/sign-in.php';
const CLP_MAINWP_LEGACY_GUARD = 'wp-content/mu-plugins/clp-addons-mainwp.php';
const CLP_MAINWP_LEGACY_SIGN_IN = array('wp-content/mu-plugins/clp-addons-login.php', 'wp-content/mu-plugins/clp-addons');

class Clp_Mainwp_Failure extends Exception {}

function clp_mainwp_fail($code) {
    throw new Clp_Mainwp_Failure($code);
}

function clp_mainwp_reply($data) {
    echo "\nCLP-ADDONS-MAINWP:" . wp_json_encode($data) . "\n";
}

function clp_mainwp_key($pubkey) {
    return $pubkey ? hash('sha256', base64_decode($pubkey)) : '';
}

// What MainWP Child's own disconnect deletes.
function clp_mainwp_disconnect_options() {
    return array(
        'mainwp_child_pubkey', 'mainwp_child_nonce', 'mainwp_security', 'mainwp_child_server',
        'mainwp_child_connected_admin', 'mainwp_ext_snippets_enabled', 'mainwp_ext_code_snippets',
        'mainwp_child_openssl_sign_algo',
    );
}

// What registration writes. Connecting an existing plugin owns only these.
function clp_mainwp_connection_options() {
    return array_merge(clp_mainwp_disconnect_options(), array('mainwp_child_uniqueId'));
}

// Everything MainWP Child, and the Dashboard through it, stores in a site's options.
function clp_mainwp_option_names() {
    global $wpdb;
    $prefixes = array('mainwp_', 'wp_mainwp_', '_transient_mainwp_', '_transient_timeout_mainwp_', '_site_transient_mainwp_', '_site_transient_timeout_mainwp_');
    $patterns = array_map(function ($prefix) use ($wpdb) { return $wpdb->esc_like($prefix) . '%'; }, $prefixes);
    $where = implode(' OR ', array_fill(0, count($patterns), 'option_name LIKE %s'));
    return $wpdb->get_col($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE $where", $patterns));
}

function clp_mainwp_meta_keys() {
    global $wpdb;
    return array(
        'auth' => $wpdb->get_blog_prefix() . 'mainwp_child_user_enable_passwd_auth_connect',
        'registers' => $wpdb->get_blog_prefix() . 'mainwp_child_user_verified_registers',
    );
}

function clp_mainwp_option($name) {
    $missing = new stdClass();
    $value = get_option($name, $missing);
    return $value === $missing ? null : base64_encode(serialize($value));
}

function clp_mainwp_meta($user, $key) {
    return metadata_exists('user', $user, $key) ? base64_encode(serialize(get_user_meta($user, $key, true))) : null;
}

function clp_mainwp_cron() {
    $cron = array();
    foreach (_get_cron_array() as $time => $hooks) {
        foreach ($hooks as $hook => $events) {
            if (strpos($hook, 'mainwp_child_') === 0) $cron[$time][$hook] = $events;
        }
    }
    return $cron;
}

function clp_mainwp_uploads() {
    return wp_get_upload_dir()['basedir'] . '/mainwp';
}

// What the addon may change. Before installing a plugin that is absent this is
// all of MainWP's settings; before connecting an existing one, only its connection.
// A connection the addon takes over is not recorded, so cleanup never restores it.
function clp_mainwp_snapshot($admin, $whole, $release = false) {
    global $wpdb;
    $options = array();
    $names = $whole ? clp_mainwp_option_names() : clp_mainwp_connection_options();
    if ($release) $names = array_diff($names, clp_mainwp_disconnect_options());
    foreach ($names as $name) {
        $value = clp_mainwp_option($name);
        if ($value !== null) $options[$name] = $value;
    }
    $meta = array();
    foreach (clp_mainwp_meta_keys() as $key) $meta[$key] = $admin ? clp_mainwp_meta($admin->ID, $key) : null;
    $tables = array();
    foreach (array('mainwp_child_changes_logs', 'mainwp_child_changes_meta') as $name) {
        $table = $wpdb->prefix . $name;
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table) $tables[] = $name;
    }
    return array(
        'options' => $options,
        'meta' => $meta,
        'admin' => $admin ? (int) $admin->ID : 0,
        'active' => is_plugin_active(CLP_MAINWP_CHILD),
        'tables' => $tables,
        'cron' => clp_mainwp_cron(),
        'uploads' => is_dir(clp_mainwp_uploads()),
    );
}

function clp_mainwp_status($admin) {
    $plugins = get_plugins();
    $snapshot = clp_mainwp_snapshot($admin, true);
    return array(
        'multisite' => is_multisite(),
        'installed' => isset($plugins[CLP_MAINWP_CHILD]),
        'files' => file_exists(WP_PLUGIN_DIR . '/mainwp-child'),
        'active' => is_plugin_active(CLP_MAINWP_CHILD),
        'key' => clp_mainwp_key(get_option('mainwp_child_pubkey', '')),
        'securityId' => (string) get_option('mainwp_child_uniqueId', ''),
        'admin' => $admin ? $admin->user_login : '',
        'fingerprint' => hash('sha256', wp_json_encode(array($snapshot['options'], $snapshot['meta'], $snapshot['active']))),
        'guard' => clp_mainwp_guard_digest(),
    );
}

// A digest of the guard, the loader that includes it and an earlier release's guard; empty without either guard.
function clp_mainwp_guard_digest() {
    if (!file_exists(ABSPATH . CLP_MAINWP_GUARD) && !file_exists(ABSPATH . CLP_MAINWP_LEGACY_GUARD)) return '';
    $digests = array();
    foreach (array(CLP_MAINWP_GUARD, CLP_MAINWP_LOADER, CLP_MAINWP_LEGACY_GUARD) as $file) {
        $digests[] = is_file(ABSPATH . $file) ? (string) hash_file('sha256', ABSPATH . $file) : '';
    }
    return hash('sha256', implode(' ', $digests));
}

function clp_mainwp_restore_options($snapshot, $names) {
    foreach ($names as $name) {
        if (!array_key_exists($name, $snapshot['options'])) delete_option($name);
        else update_option($name, unserialize(base64_decode($snapshot['options'][$name]), array('allowed_classes' => false)));
    }
}

/** Whether every key now holds what the snapshot recorded. */
function clp_mainwp_restore_meta($snapshot, $keys) {
    $restored = true;
    foreach ($keys as $key) {
        $value = $snapshot['meta'][$key] ?? null;
        if ($value === null) delete_user_meta($snapshot['admin'], $key);
        else update_user_meta($snapshot['admin'], $key, unserialize(base64_decode($value), array('allowed_classes' => false)));
        $restored = $restored && clp_mainwp_meta($snapshot['admin'], $key) === $value;
    }
    return $restored;
}

// The ID-only connection is allowed only while this is off for the administrator.
// A connection to any other Dashboard is dropped first, as the Child's own Disconnect
// does; the reply carries it, so a registration that fails can give it back.
function clp_mainwp_prepare($admin, $input) {
    if (is_multisite() || !$admin || (int) $admin->ID !== (int) $input['admin']) clp_mainwp_fail('admin-changed');
    if (defined('MAINWP_CHILD_UNIQUEID')) clp_mainwp_fail('constant-id');
    $released = array();
    if (get_option('mainwp_child_pubkey')) {
        foreach (clp_mainwp_disconnect_options() as $name) {
            $value = clp_mainwp_option($name);
            if ($value !== null) $released[$name] = $value;
        }
    }
    foreach (clp_mainwp_disconnect_options() as $name) delete_option($name);
    update_option('mainwp_child_uniqueId', $input['token']);
    update_user_option($admin->ID, 'mainwp_child_user_enable_passwd_auth_connect', 0);
    // Activation reports output as an error even after it has activated.
    activate_plugin(CLP_MAINWP_CHILD);
    if (!is_plugin_active(CLP_MAINWP_CHILD)) clp_mainwp_fail('activation-failed');
    return array('ok' => true, 'released' => $released);
}

// Only while no registration has landed, which would have set a key of its own.
function clp_mainwp_give_back($input) {
    if (!get_option('mainwp_child_pubkey')) clp_mainwp_restore_options(array('options' => $input['options']), clp_mainwp_disconnect_options());
    return array('ok' => true);
}

// For a Dashboard on another server. Clearing the not-connected time starts
// MainWP Child's own connection timeout afresh, from the next admin page load.
function clp_mainwp_activate() {
    if (is_multisite()) clp_mainwp_fail('activation-failed');
    if (get_option('mainwp_child_pubkey')) clp_mainwp_fail('already-connected');
    delete_option('mainwp_child_lasttime_not_connected');
    activate_plugin(CLP_MAINWP_CHILD);
    if (!is_plugin_active(CLP_MAINWP_CHILD)) clp_mainwp_fail('activation-failed');
    return array('ok' => true);
}

function clp_mainwp_restore_auth($input) {
    $snapshot = $input['snapshot'];
    if (!clp_mainwp_restore_meta($snapshot, array(clp_mainwp_meta_keys()['auth']))) clp_mainwp_fail('auth-not-restored');
    if (!$snapshot['active'] && !get_option('mainwp_child_pubkey')) deactivate_plugins(CLP_MAINWP_CHILD);
    return array('ok' => true);
}

// A file, or a directory and everything in it, without following links.
function clp_mainwp_remove($path) {
    if (is_link($path) || is_file($path)) return unlink($path);
    if (!is_dir($path)) return true;
    $names = scandir($path);
    if ($names === false) return false;
    foreach (array_diff($names, array('.', '..')) as $name) {
        if (!clp_mainwp_remove($path . '/' . $name)) return false;
    }
    return rmdir($path);
}

// Unchanged content is not written again.
function clp_mainwp_put($file, $code) {
    if (is_file($file) && !is_link($file) && file_get_contents($file) === $code) return;
    $temp = $file . '.' . wp_generate_password(8, false) . '.tmp';
    if (file_put_contents($temp, $code) === false || !chmod($temp, 0644) || !rename($temp, $file)) {
        if (file_exists($temp)) unlink($temp);
        clp_mainwp_fail('guard-failed');
    }
}

// Written and removed as the site's user; WP-CLI loads them, but nothing in them acts there.
// The loader goes with the last module only when the folder is empty and the loader is ours;
// writing the guard removes both earlier releases' files.
function clp_mainwp_guard($input) {
    if (!is_string($input['code'] ?? null) || !is_string($input['loader'] ?? null) || $input['loader'] === '') clp_mainwp_fail('invalid-input');
    $remove = array(CLP_MAINWP_LEGACY_GUARD);
    $loader = ABSPATH . CLP_MAINWP_LOADER;
    if ($input['code'] === '') {
        array_unshift($remove, CLP_MAINWP_GUARD);
    } else {
        if (wp_normalize_path(untrailingslashit(WPMU_PLUGIN_DIR)) !== wp_normalize_path(dirname($loader))) clp_mainwp_fail('guard-moved');
        if ((file_exists($loader) || is_link($loader)) && (is_link($loader) || !is_file($loader) || @file_get_contents($loader) !== $input['loader'])) {
            clp_mainwp_fail('loader-conflict');
        }
        if (!wp_mkdir_p(ABSPATH . CLP_MAINWP_MODULES)) clp_mainwp_fail('guard-failed');
        clp_mainwp_put(ABSPATH . CLP_MAINWP_GUARD, $input['code']);
        clp_mainwp_put($loader, $input['loader']);
        $remove = array_merge($remove, CLP_MAINWP_LEGACY_SIGN_IN);
    }
    foreach ($remove as $file) {
        if (!clp_mainwp_remove(ABSPATH . $file)) clp_mainwp_fail('guard-failed');
    }
    if ($input['code'] === '' && !file_exists(ABSPATH . CLP_MAINWP_SIGN_IN) && !is_link(ABSPATH . CLP_MAINWP_SIGN_IN)) {
        $modules = ABSPATH . CLP_MAINWP_MODULES;
        if (is_dir($modules) && !is_link($modules)) @rmdir($modules);
        if (!file_exists($modules) && !is_link($modules) && !is_link($loader) && is_file($loader) && @file_get_contents($loader) === $input['loader']) {
            if (!unlink($loader)) clp_mainwp_fail('guard-failed');
        }
    }
    return array('ok' => true);
}

function clp_mainwp_restore_artifacts($snapshot) {
    global $wpdb;
    $cron = _get_cron_array();
    foreach ($cron as $time => $hooks) {
        foreach (array_keys($hooks) as $hook) {
            if (strpos($hook, 'mainwp_child_') === 0) unset($cron[$time][$hook]);
        }
        if (!$cron[$time]) unset($cron[$time]);
    }
    foreach ($snapshot['cron'] as $time => $hooks) {
        foreach ($hooks as $hook => $events) $cron[$time][$hook] = $events;
    }
    _set_cron_array($cron);
    foreach (array('mainwp_child_changes_logs', 'mainwp_child_changes_meta') as $name) {
        if (!in_array($name, $snapshot['tables'], true)) $wpdb->query('DROP TABLE IF EXISTS `' . str_replace('`', '``', $wpdb->prefix . $name) . '`');
    }
    // MainWP creates the directory with an empty index.php; anything else in it stays.
    $upload = clp_mainwp_uploads();
    if (!$snapshot['uploads'] && is_dir($upload) && !array_diff(scandir($upload), array('.', '..', 'index.php'))) {
        if (file_exists($upload . '/index.php')) unlink($upload . '/index.php');
        rmdir($upload);
    }
}

function clp_mainwp_cleanup($admin, $input) {
    $snapshot = $input['snapshot'];
    $remove = !empty($input['removePlugin']);
    if (clp_mainwp_key(get_option('mainwp_child_pubkey', '')) !== $input['key']) clp_mainwp_fail('connection-changed');
    if ($remove || !$snapshot['active']) deactivate_plugins(CLP_MAINWP_CHILD);
    $names = $remove ? array_unique(array_merge(clp_mainwp_option_names(), array_keys($snapshot['options']))) : clp_mainwp_connection_options();
    clp_mainwp_restore_options($snapshot, $names);
    $restored = clp_mainwp_restore_meta($snapshot, array_values(clp_mainwp_meta_keys()));
    if ($remove) {
        clp_mainwp_restore_artifacts($snapshot);
        if (file_exists(WP_PLUGIN_DIR . '/mainwp-child')) {
            $deleted = delete_plugins(array(CLP_MAINWP_CHILD));
            if (is_wp_error($deleted) || !$deleted) clp_mainwp_fail('delete-failed');
        }
    }
    $after = clp_mainwp_snapshot($admin, $remove);
    $expected = $remove ? $snapshot['options'] : array_intersect_key($snapshot['options'], array_flip($names));
    $restored = $restored && $after['options'] == $expected && $after['active'] === $snapshot['active'];
    if ($remove) {
        $restored = $restored && !file_exists(WP_PLUGIN_DIR . '/mainwp-child')
            && $after['cron'] == $snapshot['cron'] && $after['tables'] == $snapshot['tables'];
    }
    if (!$restored) clp_mainwp_fail('cleanup-incomplete');
    return array('ok' => true);
}

// The Dashboard plugin is loaded here, after WordPress, as its first administrator.
function clp_mainwp_dashboard() {
    if (is_multisite() || !is_plugin_active('mainwp/mainwp.php')) clp_mainwp_fail('dashboard-unavailable');
    $admins = get_users(array('role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1, 'fields' => 'ID'));
    if (!$admins) clp_mainwp_fail('dashboard-unavailable');
    wp_set_current_user((int) $admins[0]);
    require_once WP_PLUGIN_DIR . '/mainwp/mainwp.php';
    return \MainWP\Dashboard\MainWP_DB::instance();
}

function clp_mainwp_find($db, $url) {
    $rows = $db->get_websites_by_url($url);
    if (is_array($rows)) return $rows ? reset($rows) : null;
    return $rows ?: null;
}

function clp_mainwp_record($site) {
    return $site ? array('id' => (int) $site->id, 'key' => clp_mainwp_key($site->pubkey)) : null;
}

function clp_mainwp_dashboard_status($input) {
    $db = clp_mainwp_dashboard();
    $sites = array();
    foreach ($input['domains'] as $domain) $sites[$domain] = clp_mainwp_record(clp_mainwp_find($db, 'https://' . $domain));
    return array('ok' => true, 'sites' => $sites);
}

// Fetched from the Dashboard's own account, as registration will be.
function clp_mainwp_dashboard_ready($input) {
    $response = wp_remote_get($input['url'], array('timeout' => 5, 'sslverify' => true, 'redirection' => 0, 'limit_response_size' => 1024));
    $code = (int) wp_remote_retrieve_response_code($response);
    return array('ready' => !is_wp_error($response) && $code >= 200 && $code < 400);
}

function clp_mainwp_dashboard_add($input) {
    $db = clp_mainwp_dashboard();
    if (clp_mainwp_find($db, $input['url'])) clp_mainwp_fail('record-exists');
    // MainWP's own child timeout is hours; fail inside the addon's deadline instead.
    add_filter('mainwp_fetch_url_site_timeout', function () { return 20; });
    $output = array();
    $result = \MainWP\Dashboard\MainWP_Manage_Sites_Handler::rest_api_add_site(array(
        'url' => $input['url'], 'name' => $input['name'], 'admin' => $input['admin'], 'uniqueid' => $input['token'], 'ssl_verify' => 1,
    ), $output);
    if (empty($result['siteid'])) clp_mainwp_fail('connect-failed');
    // Adding stores "use the global setting"; this connection verified its certificate, so keep verifying.
    $db->update_website_values((int) $result['siteid'], array('verify_certificate' => 1));
    return array('ok' => true);
}

// A record the Dashboard already has keeps its id, groups and notes: MainWP's own
// reconnect registers it again, with the Security ID the child was just given.
function clp_mainwp_dashboard_reconnect($input) {
    $db = clp_mainwp_dashboard();
    $site = clp_mainwp_find($db, $input['url']);
    if (!$site || (int) $site->id !== (int) $input['id']) clp_mainwp_fail('connection-changed');
    add_filter('mainwp_fetch_url_site_timeout', function () { return 20; });
    $db->update_website_values((int) $site->id, array('uniqueId' => $input['token'], 'adminname' => $input['admin'], 'verify_certificate' => 1));
    try {
        $done = \MainWP\Dashboard\MainWP_Manage_Sites_View::m_reconnect_site($db->get_website_by_id((int) $site->id), false);
    } catch (Throwable $error) {
        $done = false;
    }
    if (!$done) clp_mainwp_fail('connect-failed');
    return array('ok' => true);
}

function clp_mainwp_cookie_files($id) {
    $dir = \MainWP\Dashboard\MainWP_System_Utility::get_mainwp_dir()[0] . 'cookies/';
    $files = array();
    if (defined('LOGGED_IN_SALT') && defined('NONCE_SALT')) $files[] = $dir . sha1(sha1('mainwp' . LOGGED_IN_SALT . $id) . NONCE_SALT . 'WP_Cookie');
    if (method_exists('\MainWP\Dashboard\MainWP_System_Utility', 'get_private_filename')) {
        $files[] = $dir . \MainWP\Dashboard\MainWP_System_Utility::get_private_filename('cookies', $id, 'WP_Cookie');
    }
    return $files;
}

/** The Dashboard's per-site tables that exist, quoted for a query. */
function clp_mainwp_site_tables($suffixes) {
    global $wpdb;
    $tables = array();
    foreach ($suffixes as $suffix) {
        $table = $wpdb->prefix . 'mainwp_' . $suffix;
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table) $tables[] = '`' . str_replace('`', '``', $table) . '`';
    }
    return $tables;
}

// MainWP's removal without its request asking the child to deactivate, as its
// own Abilities API does; the child has been cleaned up already. A record whose
// key has changed was reconnected by someone else and is left alone.
function clp_mainwp_dashboard_remove($input) {
    global $wpdb;
    $db = clp_mainwp_dashboard();
    $id = (int) $input['id'];
    $site = $db->get_website_by_id($id);
    if ($site && clp_mainwp_key($site->pubkey) !== $input['key']) return array('ok' => true);
    $key_file = \MainWP\Dashboard\MainWP_Encrypt_Data_Lib::get_key_file($id, true);
    if ($site) \MainWP\Dashboard\MainWP_Manage_Sites_Handler::delete_website_favicon($site);
    if ($db->remove_website($id) === false) clp_mainwp_fail('dashboard-cleanup-incomplete');
    if ($site) {
        foreach (array('mainwp_delete_site', 'mainwp_site_deleted') as $hook) {
            try { do_action($hook, $site); } catch (Throwable $error) { /* as MainWP's own removal */ }
        }
    }
    \MainWP\Dashboard\MainWP_Encrypt_Data_Lib::remove_key_file($id);
    foreach (clp_mainwp_cookie_files($id) as $file) {
        if (file_exists($file)) unlink($file);
    }
    // Rows MainWP's removal leaves behind.
    foreach (clp_mainwp_site_tables(array('wp_settings_backup', 'request_log')) as $table) {
        $wpdb->query($wpdb->prepare("DELETE FROM $table WHERE wpid = %d", $id));
    }
    if ($db->get_website_by_id($id) || file_exists($key_file)) clp_mainwp_fail('dashboard-cleanup-incomplete');
    foreach (clp_mainwp_cookie_files($id) as $file) {
        if (file_exists($file)) clp_mainwp_fail('dashboard-cleanup-incomplete');
    }
    foreach (clp_mainwp_site_tables(array('wp_group', 'wp_sync', 'wp_options', 'wp_settings_backup', 'request_log')) as $table) {
        $count = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE wpid = %d", $id));
        if ($wpdb->last_error || (int) $count !== 0) clp_mainwp_fail('dashboard-cleanup-incomplete');
    }
    return array('ok' => true);
}

try {
    $input = json_decode(stream_get_contents(STDIN), true);
    if (!is_array($input) || !is_string($input['op'] ?? null)) clp_mainwp_fail('invalid-input');
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $admins = get_users(array('role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1));
    $admin = $admins ? $admins[0] : null;
    switch ($input['op']) {
        case 'status': $reply = clp_mainwp_status($admin); break;
        case 'snapshot': $reply = array('snapshot' => clp_mainwp_snapshot($admin, !empty($input['whole']), !empty($input['release']))); break;
        case 'prepare': $reply = clp_mainwp_prepare($admin, $input); break;
        case 'activate': $reply = clp_mainwp_activate(); break;
        case 'restore-auth': $reply = clp_mainwp_restore_auth($input); break;
        case 'cleanup': $reply = clp_mainwp_cleanup($admin, $input); break;
        case 'guard': $reply = clp_mainwp_guard($input); break;
        case 'give-back': $reply = clp_mainwp_give_back($input); break;
        case 'dashboard-status': $reply = clp_mainwp_dashboard_status($input); break;
        case 'dashboard-ready': $reply = clp_mainwp_dashboard_ready($input); break;
        case 'dashboard-add': $reply = clp_mainwp_dashboard_add($input); break;
        case 'dashboard-reconnect': $reply = clp_mainwp_dashboard_reconnect($input); break;
        case 'dashboard-remove': $reply = clp_mainwp_dashboard_remove($input); break;
        default: clp_mainwp_fail('invalid-input');
    }
    clp_mainwp_reply($reply);
} catch (Clp_Mainwp_Failure $failure) {
    clp_mainwp_reply(array('error' => $failure->getMessage()));
} catch (Throwable $error) {
    clp_mainwp_reply(array('error' => 'failed'));
}
