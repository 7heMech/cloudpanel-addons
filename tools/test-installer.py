"""Run the real picker in a controlling PTY, without running the installer."""
import os
from pathlib import Path
import pty
import select
import signal
import tempfile
import time

source = Path('install.sh').read_text()
picker = source.split('# --- choose addons')[1].split("IFS=',' read")[0]
picker = picker[picker.index('have_tty()'):]
script = '''set -euo pipefail
AVAILABLE_ADDONS=(instatic stager)
SELECTED=""
ASSUME_YES=0
say() { printf '%s\\n' "$*"; }
die() { echo "$*"; exit 1; }
''' + picker + '\nprintf "RESULT=%s\\n" "$SELECTED"\n'

cases = [
    ('all by default', b'\n', 'instatic,stager', 'xterm'),
    ('arrow and space', b'\x1b[B \n', 'instatic', 'xterm'),
    ('clear and choose', b'n \n', 'instatic', 'xterm'),
    ('select all hotkey', b'na\n', 'instatic,stager', 'xterm'),
    ('empty cannot submit', b'n\na\n', 'instatic,stager', 'xterm'),
    ('cancel', b'q', None, 'xterm'),
    ('plain terminal', b'2\n', 'stager', 'dumb'),
]
with tempfile.NamedTemporaryFile(mode='w', suffix='.sh') as f:
    f.write(script)
    f.flush()
    for name, keys, expected, term in cases:
        pid, fd = pty.fork()
        if pid == 0:
            os.environ['TERM'] = term
            os.execvp('bash', ['bash', f.name])
        output = b''
        sent = False
        deadline = time.monotonic() + 5
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([fd], [], [], .1)
                if ready:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    if not sent and (b'[x] stager' in output or b'[all]:' in output):
                        os.write(fd, keys)
                        sent = True
            else:
                raise AssertionError(f'{name}: timed out: {output!r}')
            _, status = os.waitpid(pid, 0)
            if expected is None:
                assert os.waitstatus_to_exitcode(status) == 1, (name, output)
            else:
                assert os.waitstatus_to_exitcode(status) == 0, (name, output)
                assert f'RESULT={expected}\r\n'.encode() in output, (name, output)
            print('ok', name)
        finally:
            os.close(fd)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
