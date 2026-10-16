<?php
$input = json_decode(stream_get_contents(STDIN), true);
if (!is_array($input)) throw new Exception('invalid input');
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$plugin = 'mainwp-child/mainwp-child.php';
$admins = get_users(array('role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1));
$admin = $admins ? $admins[0] : null;
function clp_reply($data) { echo "\nCLP-ADDONS-MAINWP:" . wp_json_encode($data) . "\n"; }
function clp_key($value) { return $value ? hash('sha256', base64_decode($value)) : ''; }
function clp_option_names() {
    global $wpdb;
    $names = $wpdb->get_col($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s OR option_name LIKE %s OR option_name = 'mainwp_security'", $wpdb->esc_like('mainwp_child_') . '%', $wpdb->esc_like('_transient_mainwp_child_') . '%', $wpdb->esc_like('_transient_timeout_mainwp_child_') . '%'));
    return $names;
}
function clp_snapshot($admin) {
    global $wpdb;
    $options = array();
    foreach (clp_option_names() as $name) $options[$name] = base64_encode(serialize(get_option($name)));
    $meta = array();
    foreach (array('mainwp_child_user_enable_passwd_auth_connect', 'mainwp_child_user_verified_registers') as $key) {
        $name = $wpdb->prefix . $key;
        $meta[$name] = $admin && metadata_exists('user', $admin->ID, $name) ? base64_encode(serialize(get_user_meta($admin->ID, $name, true))) : null;
    }
    $cron = array();
    foreach (_get_cron_array() as $time => $hooks) foreach ($hooks as $hook => $events) if (strpos($hook, 'mainwp_child_') === 0) $cron[$time][$hook] = $events;
    $tables = array();
    foreach (array('mainwp_child_changes_logs', 'mainwp_child_changes_meta') as $name) {
        $table = $wpdb->prefix . $name;
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) === $table) $tables[] = $name;
    }
    return array('options' => $options, 'meta' => $meta, 'admin' => $admin ? (int)$admin->ID : 0, 'active' => is_plugin_active('mainwp-child/mainwp-child.php'), 'tables' => $tables, 'cron' => $cron, 'uploads' => is_dir(wp_get_upload_dir()['basedir'] . '/mainwp'));
}
function clp_restore_meta($snapshot) {
    foreach ($snapshot['meta'] as $key => $value) {
        if ($value === null) delete_user_meta($snapshot['admin'], $key);
        else update_user_meta($snapshot['admin'], $key, unserialize(base64_decode($value), array('allowed_classes' => false)));
    }
}
function clp_restore_auth($snapshot) {
    foreach ($snapshot['meta'] as $key => $value) if (substr($key, -strlen('mainwp_child_user_enable_passwd_auth_connect')) === 'mainwp_child_user_enable_passwd_auth_connect') {
        if ($value === null) delete_user_meta($snapshot['admin'], $key);
        else update_user_meta($snapshot['admin'], $key, unserialize(base64_decode($value), array('allowed_classes' => false)));
        $actual = metadata_exists('user', $snapshot['admin'], $key) ? base64_encode(serialize(get_user_meta($snapshot['admin'], $key, true))) : null;
        if ($actual !== $value) throw new Exception('authentication restoration incomplete');
    }
}
function clp_dashboard() {
    $file = 'mainwp/mainwp.php';
    if (is_multisite() || !is_plugin_active($file)) throw new Exception('dashboard unavailable');
    wp_set_current_user(get_users(array('role' => 'administrator', 'orderby' => 'ID', 'order' => 'ASC', 'number' => 1, 'fields' => 'ID'))[0] ?? 0);
    if (!current_user_can('manage_options')) throw new Exception('no dashboard admin');
    require_once WP_PLUGIN_DIR . '/' . $file;
    return \MainWP\Dashboard\MainWP_DB::instance();
}
function clp_find($db, $url) {
    $rows = $db->get_websites_by_url($url);
    if (is_array($rows)) return $rows ? reset($rows) : null;
    return $rows ?: null;
}
function clp_site($site) {
    return $site ? array('id' => (int)$site->id, 'key' => clp_key($site->pubkey)) : null;
}
try {
    $op = $input['op'];
    if ($op === 'status') {
        $plugins = get_plugins();
        clp_reply(array('multisite' => is_multisite(), 'installed' => isset($plugins[$plugin]), 'active' => is_plugin_active($plugin), 'key' => clp_key(get_option('mainwp_child_pubkey', '')), 'securityId' => get_option('mainwp_child_uniqueId', ''), 'admin' => $admin ? $admin->user_login : '', 'snapshot' => clp_snapshot($admin)));
    } elseif ($op === 'prepare') {
        if (is_multisite() || !$admin || (int)$admin->ID !== $input['snapshot']['admin']) throw new Exception('admin changed');
        if (get_option('mainwp_child_pubkey')) throw new Exception('already connected');
        if (defined('MAINWP_CHILD_UNIQUEID')) throw new Exception('constant security id');
        update_option('mainwp_child_uniqueId', $input['token'], false);
        update_user_option($admin->ID, 'mainwp_child_user_enable_passwd_auth_connect', 0);
        $result = activate_plugin($plugin);
        if (is_wp_error($result) || !is_plugin_active($plugin)) throw new Exception('activation failed');
        clp_reply(array('ok' => true));
    } elseif ($op === 'restore-auth') {
        clp_restore_auth($input['snapshot']);
        if (!empty($input['deactivate']) && !$input['snapshot']['active'] && !get_option('mainwp_child_pubkey')) deactivate_plugins($plugin);
        clp_reply(array('ok' => true));
    } elseif ($op === 'cleanup') {
        $snapshot = $input['snapshot'];
        $key = clp_key(get_option('mainwp_child_pubkey', ''));
        if ($key && $key !== $input['key']) throw new Exception('connection changed');
        if (!$snapshot['active'] || $input['removePlugin']) deactivate_plugins($plugin);
        $connection = array('mainwp_child_pubkey', 'mainwp_child_nonce', 'mainwp_security', 'mainwp_child_server', 'mainwp_child_connected_admin', 'mainwp_child_openssl_sign_algo', 'mainwp_child_uniqueId');
        foreach ($input['removePlugin'] ? clp_option_names() : $connection as $name) {
            if (array_key_exists($name, $snapshot['options'])) update_option($name, unserialize(base64_decode($snapshot['options'][$name]), array('allowed_classes' => false)));
            else delete_option($name);
        }
        clp_restore_meta($snapshot);
        if ($input['removePlugin']) {
            $cron = _get_cron_array();
            foreach ($cron as $time => &$hooks) {
                foreach (array_keys($hooks) as $hook) if (strpos($hook, 'mainwp_child_') === 0) unset($hooks[$hook]);
                if (!$hooks) unset($cron[$time]);
            }
            unset($hooks);
            foreach ($snapshot['cron'] as $time => $hooks) foreach ($hooks as $hook => $events) $cron[$time][$hook] = $events;
            _set_cron_array($cron);
            global $wpdb;
            foreach (array('mainwp_child_changes_logs', 'mainwp_child_changes_meta') as $name) if (!in_array($name, $snapshot['tables'], true)) {
                $table = $wpdb->prefix . $name;
                $wpdb->query('DROP TABLE IF EXISTS `' . str_replace('`', '``', $table) . '`');
            }
            $upload = wp_get_upload_dir()['basedir'] . '/mainwp';
            if (isset($snapshot['uploads']) && !$snapshot['uploads'] && is_dir($upload) && !array_diff(scandir($upload), array('.', '..', 'index.php'))) {
                if (file_exists($upload . '/index.php')) unlink($upload . '/index.php');
                rmdir($upload);
            }
            if (file_exists(WP_PLUGIN_DIR . '/' . $plugin)) {
                $result = delete_plugins(array($plugin));
                if (is_wp_error($result) || !$result) throw new Exception('delete failed');
            }
        }
        $after = clp_snapshot($admin);
        if (get_option('mainwp_child_pubkey', '') || ($input['removePlugin'] && file_exists(WP_PLUGIN_DIR . '/' . $plugin))) throw new Exception('cleanup incomplete');
        foreach ($connection as $name) if (($after['options'][$name] ?? null) !== ($snapshot['options'][$name] ?? null)) throw new Exception('connection cleanup incomplete');
        if ($after['meta'] !== $snapshot['meta'] || $after['active'] !== $snapshot['active']) throw new Exception('settings cleanup incomplete');
        if ($input['removePlugin'] && ($after['options'] != $snapshot['options'] || $after['cron'] != $snapshot['cron'] || $after['tables'] != $snapshot['tables'])) throw new Exception('artifact cleanup incomplete');
        clp_reply(array('ok' => true));
    } elseif ($op === 'dashboard-status') {
        $db = clp_dashboard();
        $sites = array();
        foreach ($input['domains'] as $domain) $sites[$domain] = clp_site(clp_find($db, 'https://' . $domain));
        clp_reply(array('ok' => true, 'sites' => $sites));
    } elseif ($op === 'dashboard-add') {
        $db = clp_dashboard();
        if (clp_find($db, $input['url'])) throw new Exception('dashboard record exists');
        $output = array();
        $result = \MainWP\Dashboard\MainWP_Manage_Sites_Handler::rest_api_add_site(array('url' => $input['url'], 'name' => $input['domain'], 'admin' => $input['admin'], 'uniqueid' => $input['token'], 'ssl_verify' => 1), $output);
        if (empty($result['siteid'])) throw new Exception('connect failed');
        $db->update_website_values((int)$result['siteid'], array('verify_certificate' => 1));
        clp_reply(array('ok' => true, 'site' => clp_site($db->get_website_by_id((int)$result['siteid']))));
    } elseif ($op === 'dashboard-remove') {
        $db = clp_dashboard();
        $site = clp_find($db, $input['url']);
        $id = (int)$input['id'];
        if ($site && ((int)$site->id !== $id || clp_key($site->pubkey) !== $input['key'])) throw new Exception('dashboard connection changed');
        if (!$site && $db->get_website_by_id($id)) throw new Exception('dashboard record changed');
        $key_file = \MainWP\Dashboard\MainWP_Encrypt_Data_Lib::get_key_file($id, true);
        $dirs = \MainWP\Dashboard\MainWP_System_Utility::get_mainwp_dir();
        $cookie_files = array();
        if (defined('LOGGED_IN_SALT') && defined('NONCE_SALT')) $cookie_files[] = $dirs[0] . 'cookies/' . sha1(sha1('mainwp' . LOGGED_IN_SALT . $id) . NONCE_SALT . 'WP_Cookie');
        if (method_exists('\\MainWP\\Dashboard\\MainWP_System_Utility', 'get_private_filename')) $cookie_files[] = $dirs[0] . 'cookies/' . \MainWP\Dashboard\MainWP_System_Utility::get_private_filename('cookies', $id, 'WP_Cookie');
        if ($site) \MainWP\Dashboard\MainWP_Manage_Sites_Handler::remove_website($site);
        \MainWP\Dashboard\MainWP_Encrypt_Data_Lib::remove_key_file($id);
        foreach ($cookie_files as $file) {
            if (file_exists($file)) unlink($file);
            if (file_exists($file)) throw new Exception('dashboard session cookie remains');
        }
        if (clp_find($db, $input['url']) || file_exists($key_file)) throw new Exception('dashboard cleanup incomplete');
        global $wpdb;
        foreach (array('wp_group', 'wp_sync', 'wp_options') as $suffix) {
            $table = $wpdb->prefix . 'mainwp_' . $suffix;
            $count = $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM `' . str_replace('`', '``', $table) . '` WHERE wpid = %d', $id));
            if ($wpdb->last_error || (int)$count !== 0) throw new Exception('dashboard related data remains');
        }
        clp_reply(array('ok' => true));
    } else throw new Exception('unknown operation');
} catch (Throwable $error) {
    clp_reply(array('error' => 'MainWP ' . ($input['op'] ?? 'operation') . ' failed. Check the plugin, administrator, HTTPS and existing connection in WordPress.'));
}
