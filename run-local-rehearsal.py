from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
import os
import subprocess
import sys
import shlex

lab = Path(__file__).resolve().parent
repo = lab.parent.parent / 'worktrees/sales-eng-7130'
env_file = repo / 'projects/sales-service/.env'
values = dict(
    line.split('=', 1) for line in env_file.read_text().splitlines()
    if line and not line.startswith('#') and '=' in line
)
source = urlsplit(values['DATABASE_URL'].strip().strip('\"\''))
if source.hostname not in ('localhost', '127.0.0.1') or source.port != 54320:
    raise SystemExit('The source connection must be local Postgres on port 54320')
environment = os.environ.copy()
environment['SQL_LAB_DATABASE_URL'] = urlunsplit(source._replace(path='/sales_source_props_lab_20261111'))
environment['APP_LOG_LEVEL'] = 'error'
command = 'source "$HOME/.nvm/nvm.sh"\nnvm use\npnpm exec jest --config ../../work/listing-source-sql/jest.config.cjs --runInBand --silent'
command += ' ' + shlex.join(sys.argv[1:])
result = subprocess.run(['bash', '-ec', command], cwd=repo, env=environment, text=True, capture_output=True)
print((result.stdout + result.stderr)[-12000:])
raise SystemExit(result.returncode)
