<?php
// Managed by clp-addons System Tweaks; rewritten by repair.
//
// CloudPanel writes these site settings into nginx vhosts without checking
// them, and nginx runs as root, so any panel account with a site could take the
// server (Full Disclosure 2026/Oct/14). This runs before CloudPanel on every
// panel request, as the pool's auto_prepend_file, and refuses such input.

(static function (): void {
    $refuse = static function (string $why): never {
        error_log('clp-addons vhost guard: refused ' . $why);
        http_response_code(403);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        echo '<!doctype html><meta charset="utf-8"><title>Change refused</title><p>',
            htmlspecialchars($why, ENT_QUOTES, 'UTF-8'),
            '</p><p>Nothing was saved.</p>';
        exit;
    };

    $ip = static function (string $value): bool {
        $parts = explode('/', $value);
        if (count($parts) > 2) return false;
        $v6 = str_contains($parts[0], ':');
        if (filter_var($parts[0], FILTER_VALIDATE_IP, $v6 ? FILTER_FLAG_IPV6 : FILTER_FLAG_IPV4) === false) return false;
        return count($parts) === 1
            || (preg_match('/\A[0-9]{1,3}\z/', $parts[1]) === 1 && (int) $parts[1] <= ($v6 ? 128 : 32));
    };
    $pattern = static fn (string $regex): \Closure => static fn (string $value): bool => preg_match($regex, $value) === 1;
    $port = $pattern('/\A[0-9]{1,5}\z/');
    $url = $pattern('~\Ahttps?://[A-Za-z0-9._\~:/?\[\]@!&()*+,=%-]+\z~i');

    // form => field => [check, message]; CloudPanel names each form after its type.
    $rules = [
        // Empty serves htdocs itself; bytes above ASCII are UTF-8 and cannot spell nginx syntax.
        'site_domain_settings' => ['rootDirectory' => [static function (string $value): bool {
            if ($value === '') return true;
            if (strlen($value) > 255) return false;
            foreach (explode('/', rtrim($value, '/')) as $folder) {
                if ($folder === '.' || $folder === '..' || preg_match('/\A[A-Za-z0-9._~@+\x80-\xFF-]+\z/', $folder) !== 1) return false;
            }
            return true;
        }, 'Root Directory may only hold folder names of letters, digits and . _ ~ @ + -, separated by /, and no . or .. folder.']],
        // The name lands in an unquoted regex, where a leading + would stop nginx loading.
        'site_blocked_bot' => ['name' => [$pattern('~\A[A-Za-z0-9 ._/:-]{1,125}\z~'),
            'A bot name may only use letters, digits, spaces and . _ / : -.']],
        'site_blocked_ip' => ['ip' => [$ip, 'Enter one IP address or CIDR range, such as 192.0.2.1 or 192.0.2.0/24.']],
        'site_basic_auth' => ['whitelistedIps' => [
            // CloudPanel trims each entry before it validates them.
            static fn (string $value): bool => $value === '' || !in_array(false, array_map(static fn (string $part): bool => $ip(trim($part)), explode(',', $value)), true),
            'Whitelisted IPs must be IP addresses or CIDR ranges separated by commas.']],
        // Inside nginx's quoted PHP_VALUE, where $ names an nginx variable.
        'site_php_settings' => ['additionalConfiguration' => [$pattern('/\A[^"\\\\{}$\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*\z/'),
            'Additional configuration directives cannot contain double quotes, backslashes, braces or $.']],
        // CloudPanel trims slashes from it before it writes proxy_pass http://<server>;.
        'site_varnish_cache_settings' => ['server' => [static fn (string $value): bool => preg_match('/\A(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?\z/', trim($value, '/')) === 1,
            'The Varnish server must be a host or IP address with an optional :port.']],
        'site_reverse_proxy_settings' => ['reverseProxyUrl' => [$url, 'The reverse proxy URL must be an http:// or https:// URL without spaces, quotes, semicolons, braces or $.']],
        'site_new_reverse_proxy' => ['reverseProxyUrl' => [$url, 'The reverse proxy URL must be an http:// or https:// URL without spaces, quotes, semicolons, braces or $.']],
        'site_nodejs_settings' => ['port' => [$port, 'The port must be a number.']],
        'site_python_settings' => ['port' => [$port, 'The port must be a number.']],
        'site_new_nodejs' => ['port' => [$port, 'The port must be a number.']],
        'site_new_python' => ['port' => [$port, 'The port must be a number.']],
    ];
    foreach ($rules as $form => $fields) {
        if (!array_key_exists($form, $_POST)) continue;
        if (!is_array($_POST[$form])) $refuse("a malformed {$form} form");
        foreach ($fields as $field => [$valid, $message]) {
            if (!array_key_exists($field, $_POST[$form])) continue;
            $value = $_POST[$form][$field];
            if (!is_string($value) || !$valid($value)) $refuse($message);
        }
    }

    // CloudPanel fills these from a file or directory the site's own user can
    // write or replace with a symlink; each site's vhost names root-owned paths
    // in their place.
    foreach ([$_GET, $_POST] as $input) {
        $template = $input['vhost-template'] ?? null;
        if (!is_string($template)) continue;
        if (str_contains($template, '{{varnish_proxy_pass}}')) {
            $refuse('The Vhost cannot use {{varnish_proxy_pass}}, which CloudPanel fills from a file the site\'s own user can write. Keep the include line clp-addons put in its place.');
        }
        // nginx resolves `..` in a log path, and a relative one from its own
        // prefix, so a path with `..` is refused wherever it seems to lead.
        $homeLog = false;
        preg_match_all('~(?:\A|[;{}\s])(?:access_log|error_log)\s+[\'"]?([^\'"\s;{}]+)~', $template, $logPaths);
        foreach ($logPaths[1] as $path) {
            $collapsed = $path;
            do {
                $previous = $collapsed;
                $collapsed = str_replace(['//', '/./'], '/', $collapsed);
            } while ($collapsed !== $previous);
            if (preg_match('~(?:\A|/)\.\.(?:/|\z)~', $path) === 1 || preg_match('~\A/home(?:/|\z)~', $collapsed) === 1) $homeLog = true;
        }
        if (str_contains($template, '{{nginx_access_log}}') || str_contains($template, '{{nginx_error_log}}') || $homeLog) {
            $refuse('The Vhost cannot use {{nginx_access_log}}, {{nginx_error_log}} or log paths under /home or with .., which the site\'s own user can replace with a symlink. Keep the /var/log/clp-addons-nginx/ lines clp-addons put in their place.');
        }
    }

    // The Vhost editor and PageSpeed's settings are raw nginx config, so only an
    // administrator, who could change the server anyway, may save them.
    $raw = false;
    foreach ([$_GET, $_POST] as $input) {
        $raw = $raw || array_key_exists('vhost-template', $input) || array_key_exists('site_page_speed_settings', $input);
    }
    if (!$raw) return;

    // Why the request is not an active administrator's, or null when it is.
    $notAdministrator = static function (): ?string {
        $id = $_COOKIE['cloudpanel'] ?? null;
        if (!is_string($id) || preg_match('/\A[A-Za-z0-9,-]{1,128}\z/', $id) !== 1) return 'no panel session';
        $path = '/home/clp/htdocs/app/files/var/sessions/sess_' . $id;
        if (is_link($path) || !is_file($path) || filesize($path) > 262144) return 'no panel session';
        $data = file_get_contents($path);
        if (!is_string($data)) return 'the session file could not be read';
        // PHP's session format: name|serialized, repeated. Each value is
        // re-serialized to find where it ends, so a string inside one cannot
        // pass for the next name.
        $attributes = null;
        for ($at = 0; $at < strlen($data);) {
            $bar = strpos($data, '|', $at);
            if ($bar === false) return 'the session file is not in PHP\'s format';
            $value = @unserialize(substr($data, $bar + 1), ['allowed_classes' => false, 'max_depth' => 32]);
            $encoded = serialize($value);
            if ($value === false || substr_compare($data, $encoded, $bar + 1, strlen($encoded)) !== 0) return 'a session value could not be read back';
            if (substr($data, $at, $bar - $at) === '_sf2_attributes') $attributes = $value;
            $at = $bar + 1 + strlen($encoded);
        }
        // CloudPanel sets this to false while a TOTP code is still owed.
        if (is_array($attributes) && ($attributes['mfaAuthenticated'] ?? null) === false) return 'the two-factor step is still pending';
        $token = is_array($attributes) ? ($attributes['_security_main'] ?? null) : null;
        $token = is_string($token) ? @unserialize($token, ['allowed_classes' => false, 'max_depth' => 32]) : null;
        // Symfony's token serializes as [firewall, [user, ...]].
        $state = is_object($token) ? (array) $token : [];
        $user = is_array($state[1] ?? null) ? ($state[1][0] ?? null) : null;
        $name = is_object($user) ? (((array) $user)["\0App\\Entity\\User\0userName"] ?? null) : null;
        if (!is_string($name) || $name === '') return 'the session holds no user this guard recognises';
        try {
            $query = (new PDO('sqlite:/home/clp/htdocs/app/data/db.sq3', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]))
                ->prepare('SELECT role, status FROM user WHERE user_name = ?');
            $query->execute([$name]);
            $row = $query->fetch(PDO::FETCH_ASSOC);
        } catch (\Throwable) {
            return 'CloudPanel\'s user table could not be read';
        }
        return is_array($row) && $row['role'] === 'ROLE_ADMIN' && (int) $row['status'] === 1 ? null : "{$name} is not an active administrator";
    };
    $why = $notAdministrator();
    if ($why !== null) {
        $refuse("Only an administrator can save the Vhost editor or PageSpeed settings ({$why}). If you are one and this persists, switch off Block nginx config injection in Addons, System Tweaks until clp-addons is updated.");
    }
})();
