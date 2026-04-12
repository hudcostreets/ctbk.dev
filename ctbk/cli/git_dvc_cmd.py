from functools import wraps
from typing import Literal

from git import Repo
from utz import run, err, env, decos, call
from utz.cli import count, flag


def step_output(key, value):
    GITHUB_OUTPUT = env.get('GITHUB_OUTPUT')
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, 'a') as f:
            kv = f'{key}={value}'
            f.write(f'{kv}\n')
            err(f"Step output: {kv}")


def git_dvc_commit(fn):
    @wraps(fn)
    def _fn(
        *args,
        allow_dirty: bool = False,
        commit_git: Literal[0, 1, 2] = 0,
        push_dvc: bool | str = False,
        dry_run: bool = False,
        **kwargs,
    ):
        if commit_git:
            repo = Repo()
            if repo.is_dirty():
                if allow_dirty:
                    err(f"Git tree has unstaged changes; continuing anyway")
                else:
                    raise RuntimeError("Git tree has unstaged changes")

        msg = call(
            fn,
            *args,
            dry_run=dry_run,
            **kwargs,
        )
        if msg:
            push_git = False
            if commit_git:
                # `git commit -am` only stages modified tracked files; new
                # .dvc files created by the pipeline are untracked. Stage
                # them explicitly so they're included in the commit.
                new_dvc = [f for f in repo.untracked_files if f.endswith('.dvc')]
                if new_dvc:
                    repo.index.add(new_dvc)
                if repo.is_dirty() or repo.index.diff('HEAD'):
                    run('git', 'commit', '-am', msg)
                    step_output('sha', repo.commit().hexsha)
                    if commit_git > 1:
                        push_git = True
                else:
                    err("Nothing to commit")
            if push_dvc:
                run('dvc', 'push', *([push_dvc] if push_dvc and isinstance(push_dvc, str) else []), dry_run=dry_run)
            if push_git:
                # Only push to Git if DVC push was successful
                run('git', 'push', dry_run=dry_run)
        else:
            if commit_git:
                err("No commit message returned, skipping commit")

    return _fn


git_dvc_cmd = decos(
    git_dvc_commit,
    flag('-a', '--allow-dirty', help="Allow Git tree to be dirty"),
    count('-c', '--commit-git', values=[0, 1, 2], help="Commit changes to Git; 0x: nothing, 1x: commit, 2x: commit and push"),
    flag('-d', '--push-dvc', help="Push DVC changes"),
    flag('-n', '--dry-run', help="Dry run; print commands but don't execute them"),
)
