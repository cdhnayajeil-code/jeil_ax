/* =====================================================================
 * datastore.js — 니즈조사 데이터 어댑터 (SurveyStore)
 * ---------------------------------------------------------------------
 * 설문폼 · 집계 대시보드 · 과제평가 시트가 공유하는 단일 데이터 계층.
 * 저장소 교체를 이 파일 한 곳에서 처리하도록 설계되었습니다.
 *
 *  [현재 / 목업 단계]
 *    - save()    : ① localStorage 캐시  ② JSON 파일 다운로드
 *    - loadAll() : ① 사용자가 고른 JSON 파일들(parseFiles)  ② localStorage
 *
 *  [이후 / OneDrive 누적 단계]  ── loadAllFromOneDrive() 참고
 *    - 응답 JSON 을 OneDrive 동기화 폴더
 *        E:\OneDrive\1.JOB\JEIL_AX\05_니즈조사\responses\ 에 누적 저장.
 *    - 대시보드는 File System Access API(showDirectoryPicker)로 그 폴더의
 *      *.json 을 직접 읽어 집계 → 폼/대시보드 화면 코드는 무변경.
 *    - 또는 사내 게이트웨이가 MS Graph API 로 OneDrive 에 기록(서버형).
 *
 *  외부 CDN/라이브러리 의존 없음 (file:// · 오프라인 안전).
 * ===================================================================== */
(function (global) {
  'use strict';

  var SCHEMA_VERSION = 1;
  var STORAGE_KEY = 'jeil_ai_needs_survey_v1';

  /* ---- 공용 상수 (폼·대시보드가 동일 라벨 공유) ----
     부서목록: UNIERP 정리자료(ERP_DB) 기준 실제 부서명 적용 (2026-06) */
  var 부서목록 = ['영업팀', '사업관리팀', '구매팀', '자재물류팀', '생산팀', '품질팀', '공정설계팀', '기계설계팀', '제어팀', '재무팀', '회계팀', '인사팀', '내부회계관리팀', '기타'];

  var Q2_옵션 = ['2시간 미만', '2~5시간', '5~10시간', '10시간 이상'];
  // Q2 구간 → 주당 환산 시간(중앙값). 절감가능시간 정량화에 사용.
  var Q2_시간환산 = { '2시간 미만': 1, '2~5시간': 3.5, '5~10시간': 7.5, '10시간 이상': 12 };

  var Q3_옵션 = [
    '보고서·문서 초안 작성', '데이터 조회·취합(ERP 포함)', '정기 리포트 자동화',
    '문서 요약·번역', '규정·매뉴얼 검색 챗봇', '데이터 분석·시각화',
    '알림·점검(재고·미수금·기한 등)'
  ];
  var Q4_옵션 = ['ERP(UNIERP)', '엑셀 파일', '그룹웨어·메일', '종이·스캔 문서'];
  var Q6_옵션 = ['답변 정확성', '보안·정보유출', '사용법 어려움', '업무 책임 소재'];

  /* ---- 빈 응답 골격 ---- */
  function emptyResponse() {
    return {
      schemaVersion: SCHEMA_VERSION,
      meta: { 부서: '', 작성자: '', 직책: '', 작성일: '', 익명: false, 제출시각: '' },
      answers: {
        q1: ['', '', ''],
        q2: '',
        q3: { selected: [], 기타: '' },
        q4: { selected: [], 기타: '' },
        q5: '',
        q6: { selected: [], 기타: '' },
        q7: '',
        q8: ''   // 기타 요청·제안 (설문 4장)
      }
    };
  }

  /* ---- 유틸 ---- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function nowStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '무명';
  }
  function recordKey(r) {
    // 같은 사람의 재제출은 덮어쓰기(중복 집계 방지)
    var m = r.meta || {};
    return [safeName(m.부서), safeName(m.작성자), safeName(m.작성일)].join('|');
  }

  /* ---- localStorage (목업 캐시) ---- */
  function loadLocal() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function writeLocal(arr) {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); return true; }
    catch (e) { return false; }
  }
  function saveLocal(response) {
    var arr = loadLocal();
    var key = recordKey(response);
    var idx = -1;
    for (var i = 0; i < arr.length; i++) { if (recordKey(arr[i]) === key) { idx = i; break; } }
    if (idx >= 0) arr[idx] = response; else arr.push(response);
    return writeLocal(arr);
  }
  function clearLocal() { writeLocal([]); }

  /* ---- JSON 파일 다운로드 ---- */
  function downloadJSON(response) {
    response.meta = response.meta || {};
    if (!response.meta.제출시각) response.meta.제출시각 = nowStamp();
    var fname = '니즈조사_' + safeName(response.meta.부서) + '_' +
      safeName(response.meta.익명 ? '익명' : response.meta.작성자) + '_' +
      safeName(response.meta.작성일 || response.meta.제출시각.slice(0, 10)) + '.json';
    var blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
    var url = global.URL.createObjectURL(blob);
    var a = global.document.createElement('a');
    a.href = url; a.download = fname;
    global.document.body.appendChild(a); a.click();
    global.document.body.removeChild(a);
    setTimeout(function () { global.URL.revokeObjectURL(url); }, 1500);
    return fname;
  }

  /* ---- JSON 파일 import (대시보드 다중 선택) ---- */
  function readFile(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        try { resolve(JSON.parse(fr.result)); }
        catch (e) { resolve(null); }
      };
      fr.onerror = function () { resolve(null); };
      fr.readAsText(file);
    });
  }
  function parseFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    return Promise.all(files.map(readFile)).then(function (list) {
      var out = [];
      list.forEach(function (j) {
        if (!j) return;
        if (Array.isArray(j)) out = out.concat(j.filter(isResponse)); // 배열 형태도 허용
        else if (isResponse(j)) out.push(j);
      });
      return out;
    });
  }
  function isResponse(j) { return j && j.meta && j.answers; }

  /* ---- 여러 소스 병합(키 기준 중복 제거) ---- */
  function mergeUnique() {
    var seen = {}, out = [];
    for (var a = 0; a < arguments.length; a++) {
      var arr = arguments[a] || [];
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        if (!isResponse(r)) continue;
        var k = recordKey(r);
        if (seen[k]) continue;
        seen[k] = 1; out.push(r);
      }
    }
    return out;
  }

  /* =================================================================
   * loadAll — 목업: localStorage 만 즉시 반환.
   * 대시보드는 추가로 parseFiles() 결과를 mergeUnique() 로 합칩니다.
   * ================================================================= */
  function loadAll() { return Promise.resolve(loadLocal()); }

  /* =================================================================
   * [차기] OneDrive 폴더 직접 읽기 (File System Access API)
   *   - 지원 브라우저(Chrome/Edge)에서만 동작. 사용자가 한 번 폴더 선택.
   *   - 선택 폴더(= OneDrive 동기화 …/05_니즈조사/responses)의 *.json 누적분을 집계.
   *   - 이 함수만 loadAll 자리에 끼우면 화면 코드 변경 없이 OneDrive 전환 완료.
   * ================================================================= */
  function isOneDriveReadable() { return typeof global.showDirectoryPicker === 'function'; }
  async function loadAllFromOneDrive() {
    if (!isOneDriveReadable()) throw new Error('이 브라우저는 폴더 직접 읽기를 지원하지 않습니다(Chrome/Edge 권장).');
    var dir = await global.showDirectoryPicker();
    var out = [];
    for await (var entry of dir.values()) {
      if (entry.kind === 'file' && /\.json$/i.test(entry.name)) {
        try {
          var f = await entry.getFile();
          var j = JSON.parse(await f.text());
          if (isResponse(j)) out.push(j);
          else if (Array.isArray(j)) out = out.concat(j.filter(isResponse));
        } catch (e) { /* 손상 파일 무시 */ }
      }
    }
    return mergeUnique(out);
  }

  /* =================================================================
   * 집계
   * ================================================================= */
  function tally(list, options, picker) {
    var c = {}; options.forEach(function (o) { c[o] = 0; });
    var 기타 = 0;
    list.forEach(function (r) {
      var v = picker(r); if (!v) return;
      (v.selected || []).forEach(function (s) { if (c.hasOwnProperty(s)) c[s]++; });
      if (v.기타 && v.기타.trim()) 기타++;
    });
    return { counts: c, 기타: 기타 };
  }

  function aggregate(list) {
    list = (list || []).filter(isResponse);
    var byDept = {};
    var 총절감시간 = 0;
    list.forEach(function (r) {
      var d = (r.meta && r.meta.부서) || '미지정';
      byDept[d] = (byDept[d] || 0) + 1;
      var h = Q2_시간환산[r.answers && r.answers.q2] || 0;
      총절감시간 += h;
    });
    return {
      총응답: list.length,
      부서수: Object.keys(byDept).length,
      부서별: byDept,
      총절감시간: Math.round(총절감시간 * 10) / 10,
      q3: tally(list, Q3_옵션, function (r) { return r.answers && r.answers.q3; }),
      q4: tally(list, Q4_옵션, function (r) { return r.answers && r.answers.q4; }),
      q6: tally(list, Q6_옵션, function (r) { return r.answers && r.answers.q6; })
    };
  }

  /* =================================================================
   * OneDrive 자동 저장 (Microsoft Graph — Entra 앱 JEIL-AX-Portal)
   * -----------------------------------------------------------------
   *  - 토큰: 포털(04) 로그인 시 localStorage('jeilax_auth')에 공유됨
   *  - 권한: Files.ReadWrite.All (위임) — 2026-06-12 관리자 동의 완료
   *  - 파일명: 사용자명_사용자ID_작성일자.json (같은 날 재저장 = 덮어쓰기 = 수정 저장)
   *  - 저장 위치: 최동혁 OneDrive /최동혁/JEIL_AX
   *      · 소유자(dh.choi) 로그인  → 본인 드라이브에 직접 저장
   *      · 타 직원 로그인          → 공유받은 'JEIL_AX' 폴더 탐색 후 저장
   *                                  (공유 미설정 시 본인 드라이브 동일 경로에 폴백 저장)
   * ================================================================= */
  var ENTRA = {
    tenant:   'c877a817-4a98-4399-acbb-0046cd07dd0c',
    clientId: 'ffb54d0e-3b68-4ec1-b4ec-abc92103350e',
    scopes:   'openid profile email offline_access User.Read Files.ReadWrite.All'
  };
  var ONEDRIVE = {
    folder:    '/최동혁/JEIL_AX',
    ownerUpn:  'dh.choi@jeilm.co.kr',
    sharedName:'JEIL_AX'
  };
  var AUTH_KEY = 'jeilax_auth';

  function getAuth() {
    try { var a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); return (a && a.at) ? a : null; }
    catch (e) { return null; }
  }
  function setAuthStore(a) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) {} }

  function refreshToken(a) {
    if (!a || !a.rt) return Promise.resolve(null);
    return fetch('https://login.microsoftonline.com/' + ENTRA.tenant + '/oauth2/v2.0/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: ENTRA.clientId, grant_type: 'refresh_token', refresh_token: a.rt, scope: ENTRA.scopes })
    }).then(function (r) { return r.json(); }).then(function (tok) {
      if (!tok.access_token) return null;
      var n = { at: tok.access_token, rt: tok.refresh_token || a.rt, exp: Date.now() + ((tok.expires_in || 3599) * 1000), name: a.name, upn: a.upn };
      setAuthStore(n); return n;
    }).catch(function () { return null; });
  }

  function ensureToken() {
    var a = getAuth();
    if (!a) return Promise.resolve(null);
    if (Date.now() < a.exp - 60000) return Promise.resolve(a);
    return refreshToken(a);
  }

  function authInfo() {
    var a = getAuth();
    return a ? { name: a.name || '', upn: a.upn || '', valid: Date.now() < a.exp, canRefresh: !!a.rt } : null;
  }

  function odFileName(a, dateStr) {
    var nm = (a.name || '사용자').replace(/[\\/:*?"<>|\s]/g, '');
    var id = (a.upn || 'unknown').split('@')[0];
    return nm + '_' + id + '_' + dateStr + '.json';
  }

  function saveToOneDrive(resp) {
    return ensureToken().then(function (a) {
      if (!a) return { ok: false, needLogin: true };
      var date = (resp.meta && resp.meta.작성일) || new Date().toISOString().slice(0, 10);
      var fn = odFileName(a, date);
      var body = JSON.stringify(resp, null, 2);
      var isOwner = (a.upn || '').toLowerCase() === ONEDRIVE.ownerUpn.toLowerCase();
      var findShared = isOwner ? Promise.resolve(null)
        : fetch('https://graph.microsoft.com/v1.0/me/drive/sharedWithMe', { headers: { Authorization: 'Bearer ' + a.at } })
            .then(function (r) { return r.ok ? r.json() : { value: [] }; })
            .then(function (j) {
              return (j.value || []).find(function (v) { return v.name === ONEDRIVE.sharedName && v.remoteItem; }) || null;
            }).catch(function () { return null; });
      return findShared.then(function (shared) {
        var url = shared
          ? 'https://graph.microsoft.com/v1.0/drives/' + shared.remoteItem.parentReference.driveId
            + '/items/' + shared.remoteItem.id + ':/' + encodeURIComponent(fn) + ':/content'
          : 'https://graph.microsoft.com/v1.0/me/drive/root:' + encodeURI(ONEDRIVE.folder) + '/' + encodeURIComponent(fn) + ':/content';
        return fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + a.at, 'Content-Type': 'application/json' }, body: body })
          .then(function (r) {
            if (r.ok) return r.json().then(function (j) {
              return { ok: true, fileName: fn, webUrl: j.webUrl || '', viaShared: !!shared, fallbackOwnDrive: (!isOwner && !shared) };
            });
            if (r.status === 401) return { ok: false, needLogin: true };
            return r.text().then(function (t) { return { ok: false, error: 'HTTP ' + r.status + ' — ' + t.slice(0, 180) }; });
          });
      });
    }).catch(function (e) { return { ok: false, error: String(e) }; });
  }

  /* ---- 공개 API ---- */
  global.SurveyStore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STORAGE_KEY: STORAGE_KEY,
    부서목록: 부서목록,
    Q2_옵션: Q2_옵션,
    Q2_시간환산: Q2_시간환산,
    Q3_옵션: Q3_옵션,
    Q4_옵션: Q4_옵션,
    Q6_옵션: Q6_옵션,
    emptyResponse: emptyResponse,
    nowStamp: nowStamp,
    recordKey: recordKey,
    isResponse: isResponse,
    // 저장
    saveLocal: saveLocal,
    loadLocal: loadLocal,
    clearLocal: clearLocal,
    downloadJSON: downloadJSON,
    // 로드
    parseFiles: parseFiles,
    mergeUnique: mergeUnique,
    loadAll: loadAll,
    // OneDrive 자동 저장 (Graph API)
    saveToOneDrive: saveToOneDrive,
    authInfo: authInfo,
    ONEDRIVE: ONEDRIVE,
    // 차기(OneDrive 읽기)
    isOneDriveReadable: isOneDriveReadable,
    loadAllFromOneDrive: loadAllFromOneDrive,
    // 집계
    aggregate: aggregate
  };
})(window);
