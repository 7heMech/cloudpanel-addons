<?php
/*
 * Plugin Name: CloudPanel Addons MainWP guard
 * Description: Keeps MainWP Child connected to this server's MainWP Dashboard. Installed and removed by the WordPress Tools addon.
 */
// WP-CLI is the server's own access, and its plugin commands list through all_plugins too.
if (defined('WP_CLI') && WP_CLI) return;
add_filter('all_plugins', function ($plugins) {
    unset($plugins['mainwp-child/mainwp-child.php']);
    return $plugins;
});
add_filter('map_meta_cap', function ($caps, $cap, $user_id, $args) {
    if ($cap === 'deactivate_plugin' && ($args[0] ?? '') === 'mainwp-child/mainwp-child.php') return array('do_not_allow');
    return $caps;
}, 10, 4);
// MainWP Child's settings page holds its Disconnect button.
add_action('admin_menu', function () {
    remove_submenu_page('options-general.php', 'mainwp_child_tab');
}, PHP_INT_MAX);
add_action('admin_init', function () {
    unset($_POST['nonce-disconnect'], $_REQUEST['nonce-disconnect']);
}, 0);
