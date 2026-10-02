# jeil-nas-worker — 사내 NAS 적재 워커(REQ-0102 · ADR-110 v3)
# 외부 설치는 PDF 글자 추출용 pypdf 하나뿐이다(버전 고정). 포트를 열지 않는다(EXPOSE 없음) — 밖으로만 연결한다.
# 빌드 컨텍스트는 이 폴더다: nas_worker.py·_env.py 는 README 의 「파일 놓기」 단계에서 여기에 함께 둔다.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    JEIL_AX_ENV_ROOT=/state \
    NAS_DATA_ROOT=/data \
    NAS_DOCS_ROOT=/docs \
    NAS_INDEX_DB=/state/index/nas_docs.sqlite

WORKDIR /app
RUN pip install --no-cache-dir pypdf==6.19.0
COPY nas_worker.py nas_index.py _env.py /app/

# 상태 볼륨(/state)은 처음 만들어질 때 이 폴더의 권한을 물려받는다 — 비루트 계정(compose 의 user:)이 쓸 수 있게 열어 둔다.
RUN mkdir -p /state/logs /state/index && chmod -R 0777 /state

# 살아 있는지: 워커가 5분 안에 로그를 썼는가(20초마다 한 줄 쓴다). 로그 파일이 없으면 아직 시작 전이다.
HEALTHCHECK --interval=120s --timeout=10s --start-period=60s --retries=3 \
  CMD python -c "import os,sys,time; p='/state/logs/nas_worker.log'; sys.exit(0 if os.path.exists(p) and time.time()-os.path.getmtime(p) < 300 else 1)"

CMD ["python", "nas_worker.py", "--serve", "--log", "/state/logs/nas_worker.log"]
