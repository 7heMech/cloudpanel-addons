<?php
// The `cloudpanel` cookie's session attributes, or why they could not be read.
// Shared by the System Tweaks guards; each installed guard holds a copy.
return static function (): array|string {
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
    if (!is_array($attributes)) return 'the session holds no attributes';
    // CloudPanel sets this to false while a TOTP code is still owed.
    if (($attributes['mfaAuthenticated'] ?? null) === false) return 'the two-factor step is still pending';
    return $attributes;
};
