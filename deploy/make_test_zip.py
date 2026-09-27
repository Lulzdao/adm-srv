"""Собрать ZIP «версии» для проверки update.ps1: из распакованного каталога, с правками.

python make_zip.py <src_dir> <out.zip> <comment_sha> [rel=append_text]...
Правка вида 'helpdesk-backend/server.js=+// строка' дописывает строку в конец файла,
'helpdesk-backend/server.js=!текст' заменяет содержимое целиком.
"""
import os
import sys
import zipfile

src, out, sha = sys.argv[1], sys.argv[2], sys.argv[3]
edits = {}
for arg in sys.argv[4:]:
    rel, _, val = arg.partition("=")
    edits[rel.replace("\\", "/")] = val

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.comment = sha.encode()
    for dirpath, _, files in os.walk(src):
        for f in files:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, src).replace("\\", "/")
            data = open(full, "rb").read()
            if rel in edits:
                val = edits[rel]
                if val.startswith("+"):
                    data = data + ("\n" + val[1:] + "\n").encode()
                elif val.startswith("!"):
                    data = val[1:].encode()
            z.writestr("adm-srv-main/" + rel, data)
print("zip:", out)
