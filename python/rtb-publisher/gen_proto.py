"""Regenerates src/rtb_publisher/_proto from the vendored proto/centrifugo/api.proto.

Run from python/: uv run --with grpcio-tools python rtb-publisher/gen_proto.py
"""

import shutil
import tempfile
from pathlib import Path

from grpc_tools import protoc

here = Path(__file__).parent
proto = here.parents[1] / "proto" / "centrifugo" / "api.proto"
out = here / "src"
with tempfile.TemporaryDirectory() as tmp:
    pkg = Path(tmp) / "rtb_publisher" / "_proto"
    pkg.mkdir(parents=True)
    shutil.copy(proto, pkg / "api.proto")
    code = protoc.main(
        ["protoc", f"-I{tmp}", f"--python_out={out}", f"--grpc_python_out={out}", str(pkg / "api.proto")]
    )
    if code != 0:
        raise SystemExit(code)
print("generated", out / "rtb_publisher" / "_proto")
