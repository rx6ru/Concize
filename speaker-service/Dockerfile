# speaker-service: PCM in over a WebSocket, speaker intervals out. CPU by default — the box
# this was packaged on has 4GB VRAM and two failed CUDA wheel installs (tmpfs quota, then an
# interrupted download), and the README already benchmarks CPU as usable (11-24ms/chunk on an
# INDIC clip). SPEAKER_DEVICE=cpu is set as an environment default below, not a code change:
# app.py reads it via `os.environ.get("SPEAKER_DEVICE", "cuda:0")`, so a deployment with a GPU
# overrides it at `docker run -e SPEAKER_DEVICE=cuda:0` without touching this file.
#
# requirements.txt deliberately omits torch/torchaudio (its own comment: install the build that
# matches your CUDA version first). This Dockerfile makes that choice for the image: the CPU
# wheel, pinned to the exact versions already proven to import and run together on this machine
# (speaker-service/.venv pip freeze, torch==2.13.0+cpu / torchaudio==2.11.0+cpu), rather than
# whatever pip's resolver would pick fresh today.
#
# Models (CAM++ speaker verification ~28MB, fsmn-vad ~2MB) are baked into the image at build
# time, not fetched on first run. ModelScope reachability is not guaranteed at deploy time in
# this environment (the managed Supabase/Qdrant/CloudAMQP hosts are unreachable here for the
# same reason — outbound access to specific external hosts is not a given), and every container
# restart on an ephemeral filesystem would otherwise re-download on its own critical path to
# first readiness. ~30MB of extra image size buys a container that starts the same way whether
# ModelScope is reachable or not.
#
# Overlap detection (overlap.py) needs pyannote.audio + HF_TOKEN and is optional by design
# (overlap.py: no HF_TOKEN -> load_model() returns None, logged, the session runs without it).
# pyannote.audio is now in requirements.txt (installed below), but the model itself is NOT
# baked into this image the way CAM++/fsmn-vad are, and no HF_TOKEN exists in this deployment's
# secret pool. Without both, overlap detection stays off in production: set HF_TOKEN in the
# container's environment (docker-compose.prod.yml's speaker-service service passes none today)
# and, if first-boot access to huggingface.co is not guaranteed here either, add a build step
# for pyannote/segmentation-3.0 matching the two RUN steps below.

FROM python:3.11-slim

WORKDIR /app

# libgomp1: torch's OpenMP runtime. libsndfile1: funasr's audio decode path (soundfile).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    MODELSCOPE_CACHE=/opt/modelscope-cache \
    SPEAKER_DEVICE=cpu

# CPU wheel, pinned to what is proven to work on this machine (see header comment).
RUN pip install --no-cache-dir torch==2.13.0+cpu torchaudio==2.11.0+cpu \
    --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py speaker.py overlap.py vad.py ./

# Bake the two models funasr loads (speaker.py / app.py load_models) into the image so a
# container never depends on ModelScope being reachable at boot. device='cpu' explicitly:
# the build has no GPU passthrough regardless of what the image will run on later.
RUN python -c "\
from funasr import AutoModel; \
AutoModel(model='iic/speech_campplus_sv_zh-cn_16k-common', device='cpu', disable_update=True); \
AutoModel(model='fsmn-vad', disable_update=True)"

RUN useradd -m -u 1000 speaker \
    && chown -R speaker:speaker /app "$MODELSCOPE_CACHE" /home/speaker
USER speaker

EXPOSE 8765

CMD ["python", "app.py"]
