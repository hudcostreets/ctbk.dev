"""R2 key helpers shared by the CLIs."""
import hashlib


def content_key(key: str, body: bytes) -> str:
    """`<stem>.<md5[:12]>.<ext>` beside `key`: where a candidate asset lands so
    it can't clobber the live one serving reads (the candidate rollout in
    `specs/station-id-trailing-zero.md`)."""
    h = hashlib.md5(body).hexdigest()[:12]
    stem, dot, ext = key.rpartition('.')
    return f'{stem}.{h}.{ext}' if dot else f'{key}.{h}'
