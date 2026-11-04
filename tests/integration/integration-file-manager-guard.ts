// bun tests/integration/integration-file-manager-guard.ts (requires Docker, and the network once to install bsdtar and PHP's zip)
//
// Runs System Tweaks' File Manager guard, as installed, in front of a stand-in
// for CloudPanel's backend.php, on the oldest and newest PHP the panel can run
// on, with a site home holding links out of it, and sends it the requests the
// File Manager sends. Every action the guard does itself, as the site user, is
// checked by its answer and by what it leaves on disk.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_MANAGER_GUARD_SCRIPT } from "../../addons/system-tweaks/file-manager-guard";

interface Case {
  name: string;
  /** The backend action and its query, or `index.php` for the File Manager's page. */
  path: string;
  body?: Record<string, string>;
  /** Multipart fields, as curl's -F takes them. */
  form?: string[];
  session?: string;
  refused: boolean;
  /** What the guard answers itself, in place of CloudPanel: its status, its body whole or a part of it, and a header line. */
  answer?: { status: number; body?: string; contains?: string; header?: string };
  /** A shell test of what the request left behind. */
  after?: string;
}

const described = (name: string) => ({ status: 200, contains: `"value":"${name}","stand-in":"getFileData","owner":"tenant"` });
const owned = (path: string, mode: string) => `[ "$(stat -c %U:%G:%a /home/tenant/${path})" = tenant:tenant:${mode} ]`;
const holds = (path: string, text: string) => `[ "$(cat /home/tenant/${path})" = "${text}" ]`;
const zipped = (path: string, names: string) =>
  `[ "$(php -r '$z = new ZipArchive(); $z->open($argv[1]); for ($i = 0; $i < $z->numFiles; $i++) echo $z->getNameIndex($i), " ";' /home/tenant/${path})" = "${names} " ]`;
const upload = (path: string) => ["upload=@/tmp/upload.txt", `upload_fullpath=${path}`];
const nothing = { status: 200, body: "" };
const invalid = { status: 200, body: "File is not valid: " };

const b64 = (text: string) => Buffer.from(text).toString("base64");
const files = (...ids: string[]) => JSON.stringify(ids.map((id) => ({ id })));

const CASES: Case[] = [
  { name: "the page without a session", path: "index.php", refused: false },
  { name: "the page with a session", path: "index.php", session: "fm1", refused: false },
  { name: "the page with a session id that climbs out", path: "index.php", session: "../../x", refused: true },
  { name: "the page with a session still owing a TOTP code", path: "index.php", session: "pending1", refused: true },
  { name: "a backend request without a session", path: "files?id=/", refused: false },
  { name: "a backend request with a session id that climbs out", path: "files?id=/", session: "../../x", refused: true },
  { name: "a backend request whose session has no File Manager user", path: "files?id=/", session: "nofm1", refused: false },
  { name: "a session naming a user with shell characters", path: "files?id=/", session: "shell1", refused: true },
  { name: "an action this guard does not know", path: "unzip?id=/", session: "fm1", refused: true },
  { name: "listing the home, which CloudPanel still does", path: "folders?id=/", session: "fm1", refused: false },
  { name: "listing a folder", path: "files?id=/d", session: "fm1", refused: false },
  { name: "listing a folder through a link out", path: "files?id=/dir-link", session: "fm1", refused: true },
  { name: "listing a sibling home", path: "files?id=/../tenant-other", session: "fm1", refused: true },

  { name: "reading a file", path: "text?id=/d/a.txt", session: "fm1", refused: false, answer: { status: 200, body: "a" } },
  { name: "reading a file that does not exist", path: "text?id=/d/nope", session: "fm1", refused: false, answer: invalid },
  { name: "reading a file only root can read, which the site user cannot", path: "text?id=/rootfile", session: "fm1", refused: false, answer: nothing },
  { name: "reading a link to a file in the home", path: "text?id=/in-link", session: "fm1", refused: true },
  { name: "the text action with no file", path: "text", session: "fm1", refused: false, answer: nothing },
  { name: "writing a file", path: "text", body: { id: "/d/w.txt", content: "written" }, session: "fm1", refused: false, answer: described("w.txt"), after: holds("d/w.txt", "written") },
  { name: "writing a file empty", path: "text", body: { id: "/d/w.txt", content: "" }, session: "fm1", refused: false, answer: { status: 200, body: "[]" }, after: "[ ! -s /home/tenant/d/w.txt ]" },
  { name: "writing a file that does not exist", path: "text", body: { id: "/d/nope", content: "x" }, session: "fm1", refused: false, answer: invalid },
  { name: "writing a file only root can write", path: "text", body: { id: "/rootfile", content: "x" }, session: "fm1", refused: false, answer: { status: 200, body: "[]" }, after: "[ \"$(cat /home/tenant/rootfile)\" = root-only ]" },
  { name: "writing through a link out", path: "text", body: { id: "/out-link", content: "x" }, session: "fm1", refused: true },
  { name: "downloading a file", path: "direct?id=/d/a.txt&download=1", session: "fm1", refused: false,
    answer: { status: 200, body: "a", header: "Content-Disposition: attachment; filename=a.txt" } },
  { name: "downloading a file sends its size", path: "direct?id=/d/a.txt&download=1", session: "fm1", refused: false, answer: { status: 200, header: "Content-Length: 2" } },
  { name: "downloading a file that does not exist", path: "direct?id=/d/nope&download=1", session: "fm1", refused: false, answer: invalid },
  { name: "downloading a file only root can read", path: "direct?id=/rootfile&download=1", session: "fm1", refused: false, answer: { status: 200, header: "Content-Length: 10" },
    after: "! grep -q root-only /tmp/body" },
  { name: "downloading through a link out", path: "direct?id=/out-link&download=1", session: "fm1", refused: true },
  { name: "downloading with ..", path: "direct?id=/d/../../../etc/passwd&download=1", session: "fm1", refused: true },

  { name: "renaming a file", path: "rename", body: { id: "/d/r.txt", name: "r2.txt" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":"\\/d\\/r2.txt"}' }, after: `${holds("d/r2.txt", "r")} && [ ! -e /home/tenant/d/r.txt ]` },
  { name: "renaming onto a full folder, which fails as CloudPanel's does", path: "rename", body: { id: "/d/rd", name: "full" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":"\\/d\\/full"}' }, after: "[ -d /home/tenant/d/rd ]" },
  { name: "renaming to a name CloudPanel does not take", path: "rename", body: { id: "/d/r2.txt", name: "x$y" }, session: "fm1", refused: false, answer: nothing },
  { name: "renaming a file that does not exist", path: "rename", body: { id: "/d/nope", name: "z" }, session: "fm1", refused: false, answer: invalid },
  { name: "renaming into a link out", path: "rename", body: { id: "/d/a.txt", name: "ln/b.txt" }, session: "fm1", refused: true },
  { name: "renaming onto a link", path: "rename", body: { id: "/d/a.txt", name: "made" }, session: "fm1", refused: true },
  { name: "renaming the home", path: "rename", body: { id: "/", name: "x" }, session: "fm1", refused: true },
  { name: "deleting a file", path: "delete", body: { id: "/d/del.txt" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":""}' }, after: "[ ! -e /home/tenant/d/del.txt ]" },
  { name: "deleting a folder", path: "delete", body: { id: "/d/deldir" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":""}' }, after: "[ ! -e /home/tenant/d/deldir ]" },
  { name: "deleting a folder only root can empty", path: "delete", body: { id: "/rootonly" }, session: "fm1", refused: false,
    answer: { status: 200, body: "[]" }, after: "[ -e /home/tenant/rootonly/kept ]" },
  { name: "deleting a file that does not exist", path: "delete", body: { id: "/d/nope" }, session: "fm1", refused: false, answer: invalid },
  { name: "deleting the home", path: "delete", body: { id: "/." }, session: "fm1", refused: true },
  { name: "uploading a file", path: "upload?id=/d", form: upload("up.txt"), session: "fm1", refused: false,
    answer: { status: 200, contains: '"value":"up.txt","stand-in":"getFileData","owner":"tenant","id":"\\/d\\/up.txt","uid":"\\/d"' },
    after: `${owned("d/up.txt", "644")} && ${holds("d/up.txt", "uploaded")}` },
  { name: "uploading over a file", path: "upload?id=/d", form: upload("up.txt"), session: "fm1", refused: false, answer: described("up.txt"), after: owned("d/up.txt", "644") },
  { name: "uploading into a subfolder", path: "upload?id=/", form: upload("d/up2.txt"), session: "fm1", refused: false, answer: described("up2.txt"), after: owned("d/up2.txt", "644") },
  { name: "uploading into a folder that does not exist", path: "upload?id=/d", form: upload("new/x.txt"), session: "fm1", refused: false, answer: invalid },
  { name: "uploading into a folder only root can write", path: "upload?id=/rootonly", form: upload("x.txt"), session: "fm1", refused: false,
    answer: { status: 200, body: '{"uid":"\\/rootonly"}' }, after: "[ ! -e /home/tenant/rootonly/x.txt ]" },
  { name: "uploading without a path", path: "upload?id=/d", form: ["upload=@/tmp/upload.txt"], session: "fm1", refused: false },
  { name: "uploading through a link", path: "upload?id=/", body: { upload_fullpath: "dir-link/x.txt" }, session: "fm1", refused: true },
  { name: "making a file", path: "makefile", body: { id: "/d", name: "new.txt" }, session: "fm1", refused: false, answer: described("new.txt"), after: owned("d/new.txt", "770") },
  { name: "making a file that exists", path: "makefile", body: { id: "/d", name: "new.txt" }, session: "fm1", refused: false, answer: described("new.txt") },
  { name: "making a file in a folder that does not exist", path: "makefile", body: { id: "/d", name: "nope/x.txt" }, session: "fm1", refused: false, answer: { status: 500, body: "" } },
  { name: "making a file with a name CloudPanel does not take", path: "makefile", body: { id: "/d", name: "a..b" }, session: "fm1", refused: false, answer: nothing },
  { name: "making a file in a folder only root can write", path: "makefile", body: { id: "/rootonly", name: "x.txt" }, session: "fm1", refused: false,
    answer: { status: 500, body: "" }, after: "[ ! -e /home/tenant/rootonly/x.txt ]" },
  { name: "making a file over a link", path: "makefile", body: { id: "/", name: "made" }, session: "fm1", refused: true },
  { name: "making a folder over a link", path: "makedir", body: { id: "/", name: "out-link" }, session: "fm1", refused: true },
  { name: "making a folder", path: "makedir", body: { id: "/d", name: "sub" }, session: "fm1", refused: false, answer: described("sub"), after: owned("d/sub", "770") },
  { name: "making a folder that exists", path: "makedir", body: { id: "/d", name: "sub" }, session: "fm1", refused: false, answer: described("sub") },
  { name: "making a folder in one that does not exist", path: "makedir", body: { id: "/d", name: "nope/y" }, session: "fm1", refused: false, answer: { status: 500, body: "" } },
  { name: "making a folder in one that is not there", path: "makedir", body: { id: "/d/nope", name: "y" }, session: "fm1", refused: false, answer: invalid },

  { name: "copying a file", path: "copy", body: { id: "/d/a.txt", to: "/" }, session: "fm1", refused: false, answer: described("a_copy.txt"), after: owned("a_copy.txt", "770") },
  { name: "copying a folder keeps the modes inside it", path: "copy", body: { id: "/cp/f", to: "/cp" }, session: "fm1", refused: false, answer: described("f_copy"),
    after: `${owned("cp/f_copy", "770")} && ${owned("cp/f_copy/sub/x", "640")}` },
  { name: "copying a file without an extension", path: "copy", body: { id: "/cp/noext", to: "/cp" }, session: "fm1", refused: false, answer: described("noext_copy."), after: owned("cp/noext_copy.", "770") },
  { name: "copying into an existing folder", path: "copy", body: { id: "/cp/a.txt", to: "/cp/into" }, session: "fm1", refused: false, answer: described("a_copy.txt"), after: owned("cp/into/a_copy.txt", "770") },
  { name: "copying a file that does not exist", path: "copy", body: { id: "/cp/nope", to: "/cp" }, session: "fm1", refused: false, answer: invalid },
  { name: "copying into a file", path: "copy", body: { id: "/cp/a.txt", to: "/cp/noext" }, session: "fm1", refused: false, answer: { status: 200, body: "[]" } },
  { name: "copying a folder onto a file of its copy's name", path: "copy", body: { id: "/cp/g", to: "/cp" }, session: "fm1", refused: false, answer: { status: 500, body: "" } },
  { name: "copying into a folder only root can write, which the site user cannot", path: "copy", body: { id: "/cp/a.txt", to: "/rootonly" }, session: "fm1", refused: false,
    answer: { status: 500, body: "" }, after: "[ ! -e /home/tenant/rootonly/a_copy.txt ]" },
  { name: "copying onto a link CloudPanel would name the copy", path: "copy", body: { id: "/c/a.txt", to: "/c" }, session: "fm1", refused: true },
  { name: "copying a folder onto a link CloudPanel would name the copy", path: "copy", body: { id: "/c/f", to: "/c" }, session: "fm1", refused: true },
  { name: "copying a file into an existing _copy folder holding a link", path: "copy", body: { id: "/k/a.txt", to: "/k" }, session: "fm1", refused: true },
  { name: "copying a folder into an existing _copy folder with a link deep inside", path: "copy", body: { id: "/k/f", to: "/k" }, session: "fm1", refused: true },
  { name: "copying a file into an existing _copy folder without links", path: "copy", body: { id: "/k/b.txt", to: "/k" }, session: "fm1", refused: false,
    answer: described("b_copy.txt"), after: owned("k/b_copy.txt/b.txt", "644") },
  { name: "copying into a link out", path: "copy", body: { id: "/d/a.txt", to: "/dir-link" }, session: "fm1", refused: true },
  { name: "moving a file", path: "move", body: { id: "/d/mv.txt", to: "/" }, session: "fm1", refused: false, answer: described("mv.txt"),
    after: `${owned("mv.txt", "770")} && [ ! -e /home/tenant/d/mv.txt ]` },
  { name: "moving a file that does not exist", path: "move", body: { id: "/d/mv.txt", to: "/" }, session: "fm1", refused: false, answer: invalid },
  { name: "moving into a folder only root can write", path: "move", body: { id: "/cp/a.txt", to: "/rootonly" }, session: "fm1", refused: false,
    answer: { status: 500, body: "" }, after: "[ -e /home/tenant/cp/a.txt ]" },
  { name: "moving into an existing folder of the same name holding a link", path: "move", body: { id: "/k/m.txt", to: "/k/dst" }, session: "fm1", refused: true },
  { name: "moving onto a link of the same name", path: "move", body: { id: "/m/a.txt", to: "/m/dst" }, session: "fm1", refused: true },

  { name: "setting permissions on a file", path: "permissions", body: { id: "/d/a.txt", permissions: "750" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":"\\/d\\/a.txt","permissions":"750"}' }, after: owned("d/a.txt", "750") },
  { name: "setting permissions hands root's files under it to the site user", path: "permissions", body: { id: "/pf", permissions: "750" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"invalid":false,"error":"","id":"\\/pf","permissions":"750"}' },
    after: `${owned("pf", "750")} && ${owned("pf/inner", "750")} && ${owned("pf/inner/rootfile", "750")} && [ "$(stat -c %U /etc/passwd)" = root ]` },
  { name: "setting permissions on the home", path: "permissions", body: { id: "/", permissions: "770" }, session: "fm1", refused: false, answer: { status: 200, body: "[]" } },
  { name: "setting permissions on a file that does not exist", path: "permissions", body: { id: "/d/nope", permissions: "770" }, session: "fm1", refused: false, answer: invalid },
  { name: "setting permissions with a shell word", path: "permissions", body: { id: "/d/a.txt", permissions: "7;id" }, session: "fm1", refused: true },
  { name: "setting permissions through a link out", path: "permissions", body: { id: "/dir-link", permissions: "755" }, session: "fm1", refused: true },

  { name: "extracting an archive", path: "extract", body: { id: "/ok.tar.gz", destinationDirectoryName: "out" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/"}' }, after: `${owned("out", "755")} && ${owned("out/ok", "750")} && ${owned("out/ok/x", "640")}` },
  { name: "extracting a zip", path: "extract", body: { id: "/ok.zip", destinationDirectoryName: "." }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/"}' }, after: owned("ok/x", "640") },
  { name: "extracting an archive holding links", path: "extract", body: { id: "/links.tar", destinationDirectoryName: "out" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/"}' }, after: "[ -L /home/tenant/out/links/out ]" },
  { name: "extracting into a folder only root can write", path: "extract", body: { id: "/ok.tar.gz", destinationDirectoryName: "rootonly" }, session: "fm1", refused: false,
    answer: { status: 200, contains: '{"path":"\\/","error":"Command \\" : \\/usr\\/bin\\/bsdtar --gunzip -xf \'\\/home\\/tenant\\/ok.tar.gz\' -C \'\\/home\\/tenant\\/rootonly\'\\" failed, error message: ' },
    after: "[ ! -e /home/tenant/rootonly/ok ]" },
  { name: "extracting an archive that does not exist", path: "extract", body: { id: "/nope.zip", destinationDirectoryName: "out" }, session: "fm1", refused: false, answer: invalid },
  { name: "extracting an archive holding a device file", path: "extract", body: { id: "/dev.tar", destinationDirectoryName: "out" }, session: "fm1", refused: true },
  { name: "extracting an archive holding a FIFO", path: "extract", body: { id: "/fifo.tar", destinationDirectoryName: "out" }, session: "fm1", refused: true },
  { name: "extracting an archive holding a setuid program", path: "extract", body: { id: "/suid.tar.gz", destinationDirectoryName: "out" }, session: "fm1", refused: true },
  { name: "extracting a file that is not an archive", path: "extract", body: { id: "/broken.zip", destinationDirectoryName: "out" }, session: "fm1", refused: true },
  { name: "extracting into a link out", path: "extract", body: { id: "/ok.tar.gz", destinationDirectoryName: "dir-link/x" }, session: "fm1", refused: true },
  { name: "extracting a .gz", path: "extract", body: { id: "/g2/y.gz", destinationDirectoryName: "out" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/g2"}' }, after: `${holds("g2/out/y", "hi")} && ${owned("g2/out", "755")} && ${owned("g2/out/y", "644")}` },
  { name: "extracting a .gz at the top of the home", path: "extract", body: { id: "/top.gz", destinationDirectoryName: "top" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/"}' }, after: owned("top/top", "644") },
  { name: "extracting a .gz that is not gzip", path: "extract", body: { id: "/g2/bad.gz", destinationDirectoryName: "out2" }, session: "fm1", refused: false,
    answer: { status: 200, contains: '{"path":"\\/g2","error":"Command \\" : \\/bin\\/gunzip \'\\/home\\/tenant\\/g2\\/out2\\/bad.gz\'\\" failed, error message: ' },
    after: owned("g2/out2/bad.gz", "644") },
  { name: "extracting a .gz into a folder only root can write", path: "extract", body: { id: "/g2/y.gz", destinationDirectoryName: "locked" }, session: "fm1", refused: false,
    answer: { status: 200, contains: '"error":"Command \\" : \\/bin\\/cp  ' }, after: "[ ! -e /home/tenant/g2/locked/y.gz ]" },
  { name: "extracting a .gz that does not exist", path: "extract", body: { id: "/g2/none.gz", destinationDirectoryName: "out" }, session: "fm1", refused: false, answer: invalid },
  { name: "extracting a .gz next to a link of its name", path: "extract", body: { id: "/g/x.gz", destinationDirectoryName: "out" }, session: "fm1", refused: true },
  { name: "extracting a .gz whose copy name is a folder holding a link", path: "extract", body: { id: "/k/y.gz", destinationDirectoryName: "out" }, session: "fm1", refused: true },

  { name: "compressing a folder and a file", path: "compress", body: { files: files("/zipme", "/d/a.txt"), target: "/" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"path":"\\/"}' }, after: `${owned("archive.zip", "770")} && ${zipped("archive.zip", "zipme/in/ zipme/in/zz.txt a.txt")}` },
  { name: "compressing a folder with a link out inside, which CloudPanel stops at", path: "compress", body: { files: files("/zl"), target: "/zl" }, session: "fm1", refused: false,
    answer: { status: 200, body: "Not a valid file: /etc/passwd" } },
  { name: "compressing into a folder that is not there", path: "compress", body: { files: files("/d/a.txt"), target: "/nope" }, session: "fm1", refused: false, answer: invalid },
  { name: "compressing into a file", path: "compress", body: { files: files("/d/a.txt"), target: "/d/a.txt" }, session: "fm1", refused: false,
    answer: { status: 200, body: '{"error":"Target directory \\"\\/home\\/tenant\\/d\\/a.txt\\" does not exist."}' } },
  { name: "compressing nothing that exists", path: "compress", body: { files: files("/d/nope"), target: "/" }, session: "fm1", refused: false, answer: nothing },
  { name: "compressing into a folder only root can write", path: "compress", body: { files: files("/d/a.txt"), target: "/rootonly" }, session: "fm1", refused: false,
    answer: { status: 200, body: "[]" }, after: "[ ! -e /home/tenant/rootonly/archive.zip ]" },
  { name: "compressing a link to a file out", path: "compress", body: { files: files("/out-link"), target: "/" }, session: "fm1", refused: true },
  { name: "compressing a link to a folder out", path: "compress", body: { files: files("/dir-link"), target: "/" }, session: "fm1", refused: true },
  { name: "compressing with ..", path: "compress", body: { files: files("/../../etc/passwd"), target: "/" }, session: "fm1", refused: true },
  { name: "compressing into a linked archive.zip", path: "compress", body: { files: files("/d/a.txt"), target: "/z" }, session: "fm1", refused: true },
  { name: "compressing into a linked folder", path: "compress", body: { files: files("/d/a.txt"), target: "/dir-link" }, session: "fm1", refused: true },
  { name: "compressing a list that is not one", path: "compress", body: { files: "\"x\"", target: "/" }, session: "fm1", refused: true },
];

const SETUP = String.raw`<?php
$sessions = '/home/clp/htdocs/app/files/var/sessions';
mkdir($sessions, 0777, true);
$write = function ($id, $attributes) use ($sessions) {
  file_put_contents("$sessions/sess_$id", '_sf2_attributes|' . serialize($attributes) . '_sf2_meta|' . serialize(['u' => 1, 'c' => 1, 'l' => 0]));
};
$write('fm1', ['_security_main' => 'x', 'clp-file-manager' => ['user' => 'tenant']]);
$write('nofm1', ['_security_main' => 'x']);
$write('pending1', ['mfaAuthenticated' => false, 'clp-file-manager' => ['user' => 'tenant']]);
$write('shell1', ['clp-file-manager' => ['user' => 'a;id']]);
`;

const HOME = `set -eu
umask 022
h=/home/tenant
mkdir -p $h/d $h/c/f $h/m/dst $h/z $h/g/out /home/tenant-other
echo a > $h/d/a.txt; echo a > $h/c/a.txt; echo a > $h/m/a.txt; echo a > /home/tenant-other/secret
echo r > $h/d/r.txt; echo m > $h/d/mv.txt; echo w > $h/d/w.txt; echo x > $h/d/del.txt
mkdir -p $h/d/deldir/in $h/d/rd $h/d/full/x; echo x > $h/d/deldir/in/f; echo k > $h/d/full/x/k
mkdir -p $h/zipme/in $h/zl $h/pf/inner; echo z > $h/zipme/in/zz.txt; ln -s /etc/passwd $h/zl/out
ln -s $h/d/a.txt $h/in-link
ln -s /etc/passwd $h/out-link
ln -s /etc $h/dir-link
ln -s /tmp/made $h/made
ln -s /tmp/copied $h/c/a_copy.txt
ln -s /tmp $h/c/f_copy
ln -s /tmp $h/m/dst/a.txt
ln -s /tmp/zipped $h/z/archive.zip
ln -s /etc $h/d/ln
ln -s /tmp/made $h/d/made
echo x | gzip > $h/g/x.gz
# Targets that already exist as folders, with links somewhere inside.
mkdir -p $h/k/a_copy.txt $h/k/f/sub $h/k/f_copy/f/sub $h/k/b_copy.txt $h/k/dst/m.txt $h/k/out/y.gz
echo a > $h/k/a.txt; echo a > $h/k/b.txt; echo a > $h/k/m.txt; echo a > $h/k/f/sub/x; echo a > $h/k/b_copy.txt/b.txt; echo x | gzip > $h/k/y.gz
ln -s /etc/passwd $h/k/a_copy.txt/a.txt
ln -s /etc/passwd $h/k/f_copy/f/sub/x
ln -s /etc $h/k/dst/m.txt/m.txt
ln -s /etc/passwd $h/k/out/y.gz/y.gz
ln -s /etc/x $h/g/out/x
# Ordinary copies, moves and extracts.
mkdir -p $h/cp/f/sub $h/cp/into $h/cp/g $h/g2/locked $h/rootonly
echo a > $h/cp/a.txt; echo a > $h/cp/noext; echo a > $h/cp/f/sub/x; chmod 640 $h/cp/f/sub/x; touch $h/cp/g_copy
echo hi | gzip > $h/g2/y.gz; echo hi | gzip > $h/top.gz; echo not gzip > $h/g2/bad.gz
mkdir -p /tmp/t/ok /tmp/t/links /tmp/t/suid && echo x > /tmp/t/ok/x && chmod 750 /tmp/t/ok && chmod 640 /tmp/t/ok/x && cp /bin/true /tmp/t/suid/run && chmod 4755 /tmp/t/suid/run
ln -s /etc/passwd /tmp/t/links/out
mknod /tmp/t/null c 1 3; mkfifo /tmp/t/fifo
bsdtar -czf $h/ok.tar.gz -C /tmp/t ok; bsdtar --format zip -cf $h/ok.zip -C /tmp/t ok; bsdtar -cf $h/links.tar -C /tmp/t links
bsdtar -cf $h/dev.tar -C /tmp/t null; bsdtar -cf $h/fifo.tar -C /tmp/t fifo; bsdtar -czf $h/suid.tar.gz -C /tmp/t suid
echo not an archive > $h/broken.zip
echo uploaded > /tmp/upload.txt
useradd --no-create-home --home-dir $h tenant
chown -R tenant:tenant $h
# Files only root may touch, in folders the site user owns or does not.
chown root:root $h/rootonly $h/g2/locked; chmod 755 $h/rootonly $h/g2/locked; echo k > $h/rootonly/kept
echo root-only > $h/rootfile; chmod 600 $h/rootfile; chown root:root $h/rootfile
echo r > $h/pf/inner/rootfile; chmod 600 $h/pf/inner/rootfile; chown root:root $h/pf/inner/rootfile
`;

const shell = (version: string) => `set -eu
{ command -v bsdtar && php -m | grep -qx zip; } >/dev/null || {
  apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y libarchive-tools libzip-dev && docker-php-ext-install zip
} >/dev/null 2>&1
# The PHP CLI the guard runs as the site user, where a CloudPanel server has it.
ln -sf /usr/local/bin/php /usr/bin/php${version}
sh /work/home.sh
php /work/setup.php
# One server per script, each its own router, since a missing path falls back
# to a docroot's index.php. PHP 8.1's server does not prepend to a router, so
# each requires the guard first, as auto_prepend_file would.
for script in backend index; do
  port=$([ $script = backend ] && echo 8000 || echo 8001)
  mkdir -p /app-$script/file-manager
  echo '<?php require "/work/file-manager-guard.php"; echo "CLOUDPANEL";' > /app-$script/file-manager/$script.php
  php -d log_errors=0 -S 127.0.0.1:$port -t /app-$script /app-$script/file-manager/$script.php >/dev/null 2>&1 &
done
# CloudPanel's File Manager class, where the guard finds it, with the private
# method it borrows to describe a file.
mkdir -p /app-backend/file-manager/src/File /vendor
echo '<?php' > /vendor/autoload.php
cat > /app-backend/file-manager/src/File/Manager.php <<'PHP'
<?php
namespace App\\File;
class Manager {
  public function __construct(private string $user) {}
  private function getFileData(\\SplFileInfo $info): array {
    if (!file_exists($info->getPathname())) return [];
    $id = implode('/', array_slice(array_filter(explode('/', (string) $info->getRealPath())), 2));
    return ['value' => $info->getFilename(), 'stand-in' => 'getFileData', 'owner' => posix_getpwuid($info->getOwner())['name'], 'id' => "/{$id}"];
  }
}
PHP
sleep 1
failed=0
while IFS="|" read -r name refused url body form cookie status_want body_want contains header after; do
  set -- -s -o /tmp/body -D /tmp/headers -w '%{http_code}'
  [ -n "$body" ] && set -- "$@" --data-raw "$body"
  if [ -n "$form" ]; then
    echo "$form" | base64 -d > /tmp/form
    while IFS= read -r field || [ -n "$field" ]; do set -- "$@" -F "$field"; done < /tmp/form
  fi
  [ -n "$cookie" ] && set -- "$@" -b "$cookie"
  status=$(curl "$@" "$url" || true)
  problem=""
  if [ -n "$status_want" ]; then
    [ "$status" = "$status_want" ] || problem="expected $status_want"
    [ -n "$body_want" ] && [ "$body_want" != "-" ] && [ "$(cat /tmp/body)" != "$(echo "$body_want" | base64 -d)" ] && problem="expected the body $(echo "$body_want" | base64 -d)"
    [ -n "$contains" ] && ! grep -qF -- "$(echo "$contains" | base64 -d)" /tmp/body && problem="expected the body to hold $(echo "$contains" | base64 -d)"
    [ -n "$header" ] && ! tr -d '\\r' < /tmp/headers | grep -qixF -- "$(echo "$header" | base64 -d)" && problem="expected the header $(echo "$header" | base64 -d)"
    [ "$body_want" = "-" ] && [ -s /tmp/body ] && problem="expected an empty body"
  elif [ "$refused" = 1 ]; then
    [ "$status" = 403 ] || problem="expected 403"
  else
    { [ "$status" = 200 ] && grep -q CLOUDPANEL /tmp/body; } || problem="expected CloudPanel's answer"
  fi
  [ -z "$problem" ] && [ -n "$after" ] && ! sh -c "$(echo "$after" | base64 -d)" && problem="left the wrong files: $(echo "$after" | base64 -d)"
  [ -n "$problem" ] && { echo "PHP ${version}: $name: $problem, got $status: $(head -c 300 /tmp/body)"; failed=1; }
done < /work/cases.tsv
exit $failed
`;

const dir = mkdtempSync(join(tmpdir(), "clp-fm-guard-"));
let failed = false;
try {
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, "file-manager-guard.php"), FILE_MANAGER_GUARD_SCRIPT);
  writeFileSync(join(dir, "setup.php"), SETUP);
  writeFileSync(join(dir, "home.sh"), HOME);
  writeFileSync(join(dir, "cases.tsv"), CASES.map((c) => [
    c.name, c.refused ? "1" : "0",
    c.path === "index.php" ? "http://127.0.0.1:8001/file-manager/index.php" : `http://127.0.0.1:8000/file-manager/backend/${c.path}`,
    c.body ? new URLSearchParams(c.body).toString() : "",
    c.form ? b64(c.form.join("\n")) : "",
    c.session ? `cloudpanel=${encodeURIComponent(c.session)}` : "",
    c.answer ? String(c.answer.status) : "",
    c.answer?.body === undefined ? "" : c.answer.body === "" ? "-" : b64(c.answer.body),
    c.answer?.contains ? b64(c.answer.contains) : "",
    c.answer?.header ? b64(c.answer.header) : "",
    c.after ? b64(c.after) : "",
  ].join("|")).join("\n") + "\n");
  for (const version of ["8.1", "8.4", "8.5"]) {
    writeFileSync(join(dir, "run.sh"), shell(version));
    const result = Bun.spawnSync(["docker", "run", "--rm", "--mount", `type=bind,source=${dir},target=/work,readonly`,
      `php:${version}-cli`, "sh", "/work/run.sh"], { stdout: "pipe", stderr: "pipe" });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    if (result.exitCode !== 0) {
      failed = true;
      console.error(output || `PHP ${version}: docker exited ${result.exitCode}`);
    } else {
      console.log(`PHP ${version}: ${CASES.length} requests answered as expected`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) process.exit(1);
