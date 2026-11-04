<?php
// Managed by clp-addons System Tweaks; rewritten by repair.
//
// CloudPanel's File Manager runs as root and joins each path a request names to
// the site user's home without checking where it leads: `..` and symbolic links
// reach the whole server. This runs before it, as its pool's auto_prepend_file,
// and refuses a request naming a path that leaves the home or passes through a
// link, and an archive holding device files or setuid programs. Then it does
// every action that writes, or reads a file's contents, itself as the site
// user, so a link planted after its checks can only reach what that user could
// anyway.

(static function (): void {
    $backend = str_ends_with($_SERVER['SCRIPT_FILENAME'] ?? '', '/file-manager/backend.php');
    $refuse = static function (string $why) use ($backend): never {
        error_log('clp-addons file manager guard: refused ' . $why);
        http_response_code(403);
        header('Cache-Control: no-store');
        if ($backend) {
            header('Content-Type: application/json');
            echo json_encode(['invalid' => true, 'error' => "Refused: {$why}."]);
        } else {
            header('Content-Type: text/html; charset=utf-8');
            echo '<!doctype html><meta charset="utf-8"><title>File Manager refused</title><p>',
                htmlspecialchars($why, ENT_QUOTES, 'UTF-8'), '</p>';
        }
        exit;
    };

    // Both of CloudPanel's scripts put this cookie in a session file's path.
    if (!array_key_exists('cloudpanel', $_COOKIE)) return;
    $attributes = (require __DIR__ . '/panel-session.php')();
    if ($attributes === 'no panel session') $refuse('there is no panel session; sign in to CloudPanel again');
    if (is_string($attributes)) {
        $refuse("{$attributes}. If this persists, switch off Keep the File Manager in the site's home in Addons, System Tweaks until clp-addons is updated");
    }
    if (!$backend) return;

    // CloudPanel picks the action by the start of the raw REQUEST_URI.
    if (preg_match('~\A/file-manager/backend/([A-Za-z]*)~', $_SERVER['REQUEST_URI'] ?? '', $match) !== 1) return;
    $action = $match[1];
    $known = ['folders', 'files', 'text', 'rename', 'delete', 'direct', 'upload', 'makefile', 'makedir', 'copy', 'move', 'permissions', 'extract', 'compress'];
    if (!in_array($action, $known, true)) $refuse("the File Manager action {$action} is not one this guard checks");

    $fm = $attributes['clp-file-manager'] ?? null;
    $user = is_array($fm) ? ($fm['user'] ?? null) : null;
    if ($user === null || $user === '') return;
    if (!is_string($user) || preg_match('/\A[A-Za-z0-9_][A-Za-z0-9._-]{0,63}\z/', $user) !== 1) $refuse('the session names no site user');
    $home = "/home/{$user}";
    if (is_link($home) || !is_dir($home)) $refuse("{$home} is not a directory");

    // A request value as the path under the home CloudPanel joins it to.
    // Nothing on the way may be a link, and a path still missing is one
    // CloudPanel will create.
    $path = static function (mixed $value, string $what, bool $notHome = false) use ($home, $refuse): string {
        if (!is_string($value) || strlen($value) > 4096 || str_contains($value, "\0")) $refuse("{$what} is not a path");
        $parts = [];
        foreach (explode('/', $value) as $part) {
            if ($part === '' || $part === '.') continue;
            if ($part === '..') $refuse("{$what} climbs out of the site's home with .. in it");
            $parts[] = $part;
        }
        if ($notHome && !$parts) $refuse("{$what} is the site's home itself");
        $at = $home;
        foreach ($parts as $part) {
            $at .= "/{$part}";
            clearstatcache(false, $at);
            if (is_link($at)) $refuse("{$what} passes through the symbolic link /" . substr($at, strlen($home) + 1));
            if (!file_exists($at)) break;
        }
        return implode('/', $parts);
    };
    // cp and mv put an item inside a target that is already a folder, and cp
    // writes through any link it meets there, so nothing under it may be one.
    $nothingLinkedUnder = static function (string $relative, string $what) use ($home, $refuse): void {
        $pending = ["{$home}/{$relative}"];
        if (is_link($pending[0]) || !is_dir($pending[0])) return;
        $seen = 0;
        while ($pending) {
            $directory = array_pop($pending);
            $entries = @scandir($directory);
            if ($entries === false) $refuse("{$what} already exists and could not be read");
            foreach ($entries as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                if (++$seen > 100000) $refuse("{$what} already exists and holds too many files to check");
                $at = "{$directory}/{$entry}";
                if (is_link($at)) $refuse("{$what} already exists and holds the symbolic link /" . substr($at, strlen($home) + 1));
                if (is_dir($at)) $pending[] = $at;
            }
        }
    };
    $joined = static fn (string $directory, string $name): string => $directory === '' ? $name : "{$directory}/{$name}";
    $dirname = static fn (string $relative): string => str_contains($relative, '/') ? substr($relative, 0, strrpos($relative, '/')) : '';
    $basename = static fn (string $relative): string => substr($relative, strrpos("/{$relative}", '/'));

    // From here the guard is CloudPanel's backend for every action that
    // writes, or reads a file's contents, and does it as the site user, so a
    // link planted after the checks above can only reach what that user could
    // anyway. Only the folder listings are left to CloudPanel. Each reply is
    // the one CloudPanel gives, which its File Manager page reads.
    $post = static fn (string $key): mixed => $_POST[$key] ?? null;
    $get = static fn (string $key): mixed => $_GET[$key] ?? null;
    $prefix = "{$home}/";
    $full = static fn (string $relative): string => $relative === '' ? $home : "{$home}/{$relative}";
    $env = ['PATH' => '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL' => 'C'];
    $workerMask = umask();
    // sudo's umask, the union of the caller's and its default 022.
    $sudoMask = $workerMask | 022;

    // CloudPanel's backend starts the File Manager's own session before it
    // acts, so its replies carry that session's headers.
    $reply = static function (string $body, int $status = 200): never {
        $data = @file_get_contents('/home/clp/htdocs/app/files/var/sessions/sess_' . $_COOKIE['cloudpanel']);
        if (is_string($data) && $data !== '') {
            session_name('clp-file-manager');
            @session_start();
            @session_decode($data);
        }
        http_response_code($status);
        echo $body;
        exit;
    };
    // CloudPanel's checkPath ends a request whose path does not resolve with this line.
    $resolves = static function (string $file) use ($reply): void {
        clearstatcache(true);
        if (realpath($file) === false) $reply('File is not valid: ');
    };
    // CloudPanel's isFilenameValid.
    $validName = static fn (mixed $name): bool => is_string($name) && preg_match('/^(?!.*\.\.)[a-zA-Z0-9_\-\ \/\.]+$/', $name) === 1;

    if (posix_getpwnam($user) === false) $refuse("{$user} is not a user on this server");
    $runuser = is_executable('/usr/sbin/runuser') ? '/usr/sbin/runuser' : '/sbin/runuser';
    // [succeeded, output, error output] of a command run as the site user.
    // $input is a file to read standard input from.
    $asUser = static function (array $argv, int $mask, mixed $input = null) use ($user, $runuser, $env): array {
        $old = umask($mask);
        $process = proc_open([$runuser, '-u', $user, '--', ...$argv], [0 => $input ?? ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, '/', $env);
        umask($old);
        if (!is_resource($process)) return [false, '', "{$argv[0]} could not be started"];
        $output = ['', ''];
        $open = [1 => $pipes[1], 2 => $pipes[2]];
        while ($open) {
            $read = array_values($open);
            $none = null;
            if (@stream_select($read, $none, $none, null) === false) break;
            foreach ($read as $pipe) {
                $key = array_search($pipe, $open, true);
                $chunk = fread($pipe, 65536);
                if ($chunk !== '' && $chunk !== false) $output[$key - 1] .= $chunk;
                elseif (feof($pipe)) { fclose($pipe); unset($open[$key]); }
            }
        }
        return [proc_close($process) === 0, $output[0], $output[1]];
    };
    // CloudPanel's command runner throws on a failed command, and the action
    // left it uncaught answers an empty 500; one that caught it shows this.
    $failed = static fn (string $shown, string $error): string => "Command \" : {$shown}\" failed, error message: {$error}";
    $crash = static function (string $what, string $error) use ($reply, $user): never {
        error_log("clp-addons file manager guard: {$what} as {$user} failed: " . trim($error));
        $reply('', 500);
    };

    // PHP's own file functions, as the site user, from a PHP CLI of the
    // version CloudPanel's pool runs.
    $php = '/usr/bin/php' . PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;
    $needPhp = static function (array $extensions) use ($php, $refuse): void {
        if (!is_executable($php)) $refuse("{$php}, which the File Manager needs to act as the site user, is missing");
        foreach ($extensions as $extension) {
            $probe = proc_open([$php, '-r', "exit(extension_loaded('{$extension}') ? 0 : 1);"], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
            if (!is_resource($probe) || proc_close($probe) !== 0) $refuse("{$php} has no {$extension} extension, which the File Manager needs");
        }
    };
    $helper = <<<'HELPER'
        $mode = $argv[1]; $file = $argv[2];
        if ($mode === 'read') { if (file_exists($file)) readfile($file); exit; }
        if ($mode === 'download') {
            if (!file_exists($file)) exit;
            $info = finfo_open(FILEINFO_MIME_TYPE);
            echo json_encode([finfo_file($info, $file), filesize($file)]), "\n";
            readfile($file);
            exit;
        }
        if ($mode === 'write') {
            if (!file_exists($file)) { echo 'missing'; exit; }
            echo file_put_contents($file, stream_get_contents(STDIN)) ? 'written' : 'empty';
            exit;
        }
        if ($mode === 'upload') {
            // move_uploaded_file: a new file in place of any old one, then 0666 less the umask.
            $directory = dirname($file);
            @mkdir($directory, 0777, true);
            $temp = @tempnam($directory, '.clp-addons-upload-');
            if ($temp === false) exit;
            if (dirname($temp) !== $directory) { @unlink($temp); exit; }
            $out = fopen($temp, 'w');
            $copied = stream_copy_to_stream(STDIN, $out) !== false && fclose($out);
            if (!$copied || !@rename($temp, $file)) { @unlink($temp); exit; }
            @chmod($file, 0666 & ~umask());
            exit;
        }
        if ($mode === 'compress') {
            [$home, $target, $id] = [$argv[2], $argv[3], $argv[4]];
            $files = array_slice($argv, 5);
            $walk = static fn (string $directory) => new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory));
            $data = [];
            try {
                if (!(is_dir($target) && $files)) throw new Exception(sprintf('Target directory "%s" does not exist.', $target));
                $count = 0;
                foreach ($files as $source) {
                    if (!file_exists($source)) continue;
                    $info = new SplFileInfo($source);
                    if ($info->isFile()) ++$count;
                    if ($info->isDir()) foreach ($walk($info->getPathname()) as $inner) if ($inner->isFile()) ++$count;
                }
                if ($count >= 100000) throw new Exception(sprintf('Too many files, maximum of "%s" files are allowed.', 100000));
                $archive = sprintf('%s/archive.zip', rtrim($target, '/'));
                $zip = new ZipArchive();
                if ($zip->open($archive, ZipArchive::CREATE) !== true) throw new Exception(sprintf('Cannot create zip file "%s".', $archive));
                foreach ($files as $source) {
                    if (!file_exists($source)) continue;
                    $info = new SplFileInfo($source);
                    if ($info->isFile()) $zip->addFile($info->getPathname(), $info->getFilename());
                    if (!$info->isDir()) continue;
                    foreach ($walk($info->getPathname()) as $inner) {
                        if (!$inner->isFile()) continue;
                        if ($inner->isLink() && !str_starts_with((string) $inner->getRealPath(), $home)) exit(sprintf('Not a valid file: %s', $inner->getRealPath()));
                        $parts = array_filter(explode('/', ltrim(str_replace($target, '', $inner->getPathname()), '/')));
                        array_pop($parts);
                        $directory = implode('/', $parts);
                        $zip->addEmptyDir($directory);
                        $zip->addFile($inner->getPathname(), sprintf('%s/%s', rtrim($directory, '/'), $inner->getFilename()));
                    }
                }
                $zip->close();
                if (file_exists($archive)) {
                    if (!@chmod($archive, 0770)) throw new Exception(sprintf('Command " : /bin/chmod  770 %s" failed, error message: %s', escapeshellarg($archive), error_get_last()['message'] ?? ''));
                    $data = ['path' => $id];
                }
            } catch (Exception $e) {
                $data['error'] = $e->getMessage();
            }
            echo json_encode($data);
        }
        HELPER;
    $asPhp = static fn (array $args, mixed $input = null): array => $asUser([$php, '-d', 'display_errors=stderr', '-d', 'memory_limit=1024M', '-r', $helper, '--', ...$args], $workerMask, $input);

    // CloudPanel's own description of a file, which its page reads back.
    $fileData = static function (string $file) use ($user): array {
        $manager = new \App\File\Manager($user);
        return (new \ReflectionMethod($manager, 'getFileData'))->invoke($manager, new \SplFileInfo($file));
    };
    $loadManager = static function () use ($refuse): void {
        $directory = dirname($_SERVER['SCRIPT_FILENAME']);
        foreach (["{$directory}/../../vendor/autoload.php", "{$directory}/src/File/Manager.php"] as $file) {
            if (!is_file($file)) $refuse('this is not a CloudPanel File Manager this guard knows');
            require_once $file;
        }
        if (!method_exists('App\File\Manager', 'getFileData')) $refuse('this is not a CloudPanel File Manager this guard knows');
    };

    // Device files cannot be made as the site user, and a setuid program would
    // be one, so an archive holding either is refused before anything happens.
    // Each line of bsdtar's listing starts with the entry's mode.
    $scan = static function (string $archive) use ($refuse, $asUser, $sudoMask): void {
        [$listed, $listing] = $asUser(['/usr/bin/bsdtar', '-tvf', $archive], $sudoMask);
        foreach (explode("\n", rtrim($listing, "\n")) as $line) {
            if ($line === '') continue;
            if (preg_match('/\A[-dlh][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]/', $line) !== 1) $refuse('the archive holds a device file, a FIFO, a socket or an entry bsdtar cannot list');
            if (preg_match('/\A.{3}[sS]|\A.{6}[sS]/', $line) === 1) $refuse('the archive holds a setuid or setgid program');
        }
        if (!$listed) $refuse('the archive could not be listed');
    };

    // CloudPanel's permissions action hands everything under the file to the
    // site user, which only root can do. find never follows a link, starts at
    // the home, which only root can replace, descends only towards the file,
    // and runs chown -h from inside each folder, so nothing outside can be
    // reached; with protected hardlinks the site user cannot link a file of
    // root's in either.
    $chownUnder = static function (string $target) use ($home, $user, $env): bool {
        if (trim((string) @file_get_contents('/proc/sys/fs/protected_hardlinks')) !== '1') return true;
        $glob = static fn (string $path): string => preg_replace('/[\\\\*?\[]/', '\\\\$0', $path);
        $ancestors = [];
        $at = $home;
        foreach (array_slice(explode('/', substr($target, strlen($home) + 1)), 0, -1) as $part) {
            $at .= "/{$part}";
            if ($ancestors) $ancestors[] = '-o';
            array_push($ancestors, '-path', $glob($at));
        }
        $process = proc_open(['/usr/bin/find', '-P', $home, '-mindepth', '1',
            '(', '-path', $glob($target), '-o', '-path', $glob($target) . '/*', ')', '(', '!', '-user', $user, '-execdir', '/bin/chown', '-h', "{$user}:{$user}", '{}', '+', '-o', '-true', ')',
            ...($ancestors ? ['-o', '(', ...$ancestors, ')'] : []), '-o', '-prune'],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, '/', $env);
        return is_resource($process) && proc_close($process) === 0;
    };

    if (in_array($action, ['folders', 'files', 'direct', 'upload'], true) && $get('id') !== null) $path($get('id'), 'the folder or file');
    switch ($action) {
        case 'text':
            if ($get('id') !== null) $path($get('id'), 'the file');
            if ($post('id') !== null) $path($post('id'), 'the file', true);
            if ($post('content') !== null && $post('id') !== null) {
                if (!is_string($post('content'))) $refuse('the content is not text');
                $file = $full($path($post('id'), 'the file', true));
                $resolves($file);
                $loadManager();
                $needPhp([]);
                $content = tmpfile();
                fwrite($content, $post('content'));
                rewind($content);
                [, $written] = $asPhp(['write', $file], $content);
                $reply($written === 'written' ? json_encode($fileData($file)) : '[]');
            }
            if ($get('id') !== null) {
                $file = $full($path($get('id'), 'the file'));
                $resolves($file);
                $needPhp([]);
                [, $content] = $asPhp(['read', $file]);
                $reply($content);
            }
            $reply('');
        case 'direct':
            if ($get('download') === null || $get('id') === null) break;
            $file = $full($path($get('id'), 'the file'));
            $resolves($file);
            $needPhp(['fileinfo']);
            $old = umask($workerMask);
            $process = proc_open([$runuser, '-u', $user, '--', $php, '-d', 'display_errors=stderr', '-r', $helper, '--', 'download', $file],
                [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, '/', $env);
            umask($old);
            if (!is_resource($process)) $crash('download', 'the PHP CLI could not be started');
            $head = json_decode((string) fgets($pipes[1]), true);
            if (!is_array($head)) { fclose($pipes[1]); proc_close($process); $reply(''); }
            $data = @file_get_contents('/home/clp/htdocs/app/files/var/sessions/sess_' . $_COOKIE['cloudpanel']);
            if (is_string($data) && $data !== '') { session_name('clp-file-manager'); @session_start(); @session_decode($data); }
            header('Content-Type: ' . $head[0]);
            header('Content-Description: File Transfer');
            header('Content-Disposition: attachment; filename=' . basename($file));
            header('Content-Transfer-Encoding: binary');
            header('Expires: 0');
            header('Cache-Control: must-revalidate, post-check=0, pre-check=0');
            header('Pragma: public');
            header('Content-Length: ' . $head[1]);
            fpassthru($pipes[1]);
            fclose($pipes[1]);
            proc_close($process);
            exit;
        case 'rename':
            if ($post('id') === null || empty($post('name'))) break;
            $from = $path($post('id'), 'the file to rename', true);
            if (!is_string($post('name'))) $refuse('the new name is not a name');
            $to = $path($joined($dirname($from), $post('name')), 'the new name', true);
            if (!$validName($post('id')) || !$validName($post('name'))) $reply('');
            $resolves($full($from));
            $resolves($full($joined($dirname($from), $dirname($post('name')))));
            if (!file_exists($full($from))) $reply('[]');
            $loadManager();
            // PHP's rename, whose result CloudPanel does not read.
            $asUser(['/bin/mv', '-T', '--', $full($from), $full($to)], $workerMask);
            $reply(json_encode(['invalid' => false, 'error' => '', 'id' => $fileData($full($to))['id'] ?? null]));
        case 'delete':
            if ($post('id') === null) break;
            $file = $full($path($post('id'), 'the file to delete', true));
            $resolves($file);
            if (!file_exists($file)) $reply('[]');
            [$deleted] = $asUser(['/bin/rm', is_dir($file) ? '-rf' : '-f', '--', $file], $sudoMask);
            $reply($deleted ? json_encode(['invalid' => false, 'error' => '', 'id' => '']) : '[]');
        case 'upload':
            if ($get('id') === null || $post('upload_fullpath') === null) break;
            if (!is_string($post('upload_fullpath'))) $refuse('the upload path is not a path');
            $target = $path($get('id') . '/' . $post('upload_fullpath'), 'the upload', true);
            $temp = $_FILES['upload']['tmp_name'] ?? null;
            if (!isset($_FILES['upload']) || $temp === null) $reply('');
            $directory = $full($path($get('id'), 'the folder'));
            $resolves($directory . '/' . ltrim(dirname($post('upload_fullpath')), '/'));
            if (!is_dir($directory) || !is_string($temp) || !is_uploaded_file($temp)) $reply('[]');
            $loadManager();
            $needPhp([]);
            // Then CloudPanel hands the folder to the site user, whose files these already are.
            $asPhp(['upload', $full($target)], fopen($temp, 'r'));
            $reply(json_encode([...$fileData($full($target)), 'uid' => $get('id')]));
        case 'makefile':
        case 'makedir':
            if ($post('id') === null || $post('name') === null) break;
            if (!is_string($post('name'))) $refuse('the new name is not a name');
            $directory = $path($post('id'), 'the folder');
            $target = $path($joined($directory, $post('name')), 'the new name', true);
            if (!$validName($post('name'))) $reply('');
            $resolves($full($directory));
            if (!is_dir($full($directory))) $reply('[]');
            $loadManager();
            $file = $full($target);
            // PHP's touch or mkdir, whose result CloudPanel does not read.
            $asUser($action === 'makefile' ? ['/usr/bin/touch', '--', $file] : ['/bin/mkdir', '--', $file], $workerMask);
            clearstatcache(true);
            if ($action === 'makefile' && is_link($file) && !str_starts_with((string) realpath($file), $prefix)) $reply('Not a valid file: ' . realpath($file));
            [$set, , $error] = $asUser(['/bin/chmod', '770', '--', $file], $sudoMask);
            if (!$set) $crash($action, $error);
            $reply(json_encode($fileData($file)));
        case 'copy':
        case 'move':
            if ($post('id') === null || $post('to') === null) break;
            $source = $path($post('id'), 'the file', true);
            $path($post('to'), 'the destination');
            // CloudPanel trims / and ) from the destination, then names the
            // copy after the source.
            $name = $basename($source);
            if ($action === 'copy') {
                $extension = pathinfo($name, PATHINFO_EXTENSION);
                $name = is_dir($full($source)) ? "{$name}_copy" : str_replace(".{$extension}", '', $name) . "_copy.{$extension}";
            }
            $target = $path(rtrim(ltrim($post('to'), '/'), '/)') . "/{$name}", 'the destination', true);
            $nothingLinkedUnder($target, 'the destination');
            $from = $full($source);
            $into = "{$home}/" . ltrim($post('to'), '/');
            $resolves($from);
            $resolves($into);
            if (!file_exists($from) || !is_dir($into)) $reply('[]');
            $loadManager();
            $target = $full($target);
            [$done, , $error] = $asUser($action === 'copy' ? ['/bin/cp', '-a', '--', $from, $target] : ['/bin/mv', '--', $from, $target], $sudoMask);
            if ($done) [$done, , $error] = $asUser(['/bin/chmod', '770', '--', $target], $sudoMask);
            if (!$done) $crash($action, $error);
            $reply(json_encode($fileData($target)));
        case 'permissions':
            if ($post('id') === null || $post('permissions') === null) break;
            $file = $full($path($post('id'), 'the file'));
            if (!is_string($post('permissions')) || preg_match('/\A[0-7]{3,4}\z/', $post('permissions')) !== 1) $refuse('permissions must be an octal mode such as 755');
            $resolves($file);
            $real = realpath($file);
            if (!is_string($real) || !str_starts_with($real, $prefix) || !file_exists($real)) $reply('[]');
            $loadManager();
            if (!$chownUnder($real)) $crash('chown', "find could not hand {$real} to {$user}");
            foreach (['d', 'f'] as $type) {
                [$set, , $error] = $asUser(['/usr/bin/find', '-P', $real, '-type', $type, '-exec', '/bin/chmod', $post('permissions'), '{}', ';'], $sudoMask);
                if (!$set) $crash('chmod', $error);
            }
            $reply(json_encode(['invalid' => false, 'error' => '', 'id' => $fileData($real)['id'] ?? null, 'permissions' => $post('permissions')]));
        case 'extract':
            if ($post('id') === null || $post('destinationDirectoryName') === null) break;
            $archive = $path($post('id'), 'the archive', true);
            if (!is_string($post('destinationDirectoryName'))) $refuse('the destination is not a path');
            $destination = $path($joined($dirname($archive), str_replace('..', '', $post('destinationDirectoryName'))), 'the destination');
            $name = $basename($archive);
            $extension = str_ends_with($name, 'tar.gz') ? 'tar.gz' : pathinfo($name, PATHINFO_EXTENSION);
            $tar = in_array($extension, ['tar', 'tgz', 'tar.gz', 'rar', 'zip'], true);
            if ($extension === 'gz') {
                // CloudPanel copies a .gz there and gunzips the copy.
                $nothingLinkedUnder($path($joined($destination, $name), 'the destination', true), 'the destination');
                $path($joined($destination, substr($name, 0, -3)), 'the destination', true);
            }
            $file = $full($archive);
            $resolves($file);
            if ($tar && is_file($file)) $scan($file);
            if (!file_exists($file)) $reply('[]');
            // It answers with the archive's folder, and a failed step's error
            // in its own words. The chown -R and chmod it runs afterwards have
            // nothing to do for files the site user made: the chown, and the
            // chmod is backgrounded and killed with the request.
            $folder = array_slice(array_filter(explode('/', (string) realpath($file))), 2);
            array_pop($folder);
            $data = ['path' => '/' . implode('/', $folder)];
            $into = rtrim($full($destination), '/');
            $steps = [];
            if ($tar) {
                $steps = [
                    [['/bin/mkdir', '-p', '--', $into], '/bin/mkdir -p ' . escapeshellarg($into)],
                    // Root's bsdtar keeps the archive's modes; -p does that for anyone.
                    [['/usr/bin/bsdtar', '-p', '--gunzip', '-xf', $file, '-C', $into], '/usr/bin/bsdtar --gunzip -xf ' . escapeshellarg($file) . ' -C ' . escapeshellarg($into)],
                ];
            } elseif ($extension === 'gz') {
                $steps = [
                    [['/bin/mkdir', '-p', '--', $into], '/bin/mkdir -p ' . escapeshellarg($into)],
                    [['/bin/cp', '--', $file, "{$into}/{$name}"], '/bin/cp  ' . escapeshellarg($file) . ' ' . escapeshellarg("{$into}/{$name}")],
                    [['/bin/gunzip', '--', "{$into}/{$name}"], '/bin/gunzip ' . escapeshellarg("{$into}/{$name}")],
                ];
            }
            foreach ($steps as [$argv, $shown]) {
                [$done, , $error] = $asUser($argv, $sudoMask);
                if ($done) continue;
                $data['error'] = $failed($shown, $error);
                break;
            }
            $reply(json_encode($data));
        case 'compress':
            if ($post('files') === null || $post('target') === null) break;
            $files = is_string($post('files')) ? json_decode($post('files'), true) : null;
            if (!is_array($files)) $refuse('the files to compress are not a list');
            $sources = [];
            foreach ($files as $file) {
                if (!is_array($file)) $refuse('the files to compress are not a list');
                if (($file['id'] ?? null) === null) continue;
                $path($file['id'], 'a file to compress');
                // CloudPanel's own spelling of each path, which its entry names come from.
                $source = "{$home}/" . ltrim($file['id'], '/');
                if (file_exists($source)) $sources[] = $source;
            }
            if (!is_string($post('target'))) $refuse('the target folder is not a path');
            $target = $path(str_replace('..', '', $post('target')), 'the target folder');
            $path($joined($target, 'archive.zip'), 'the archive');
            if (!$sources) $reply('');
            $resolves($full($target));
            $needPhp(['zip']);
            // CloudPanel's compress, as the site user: the same entries in the
            // same order, the same refusal of a link that leads out, and the
            // same chmod of the archive; the chown has nothing to do.
            [, $body] = $asPhp(['compress', $prefix, "{$home}/" . ltrim(str_replace('..', '', $post('target')), '/'), str_replace('..', '', $post('target')), ...$sources]);
            $reply($body);
    }
})();
