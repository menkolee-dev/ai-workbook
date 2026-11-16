"""Small, read-only building-register client. No API key or response-body logging.

Contract checked against the official portal's embedded Swagger on 2026-11-16:
https://www.data.go.kr/data/15134735/openapi.do
Only this fixed GET operation is available; there is no arbitrary URL fetch tool.
"""
from __future__ import annotations

import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SOURCE_URL = "https://www.data.go.kr/data/15134735/openapi.do"
ENDPOINT = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"
TIMEOUT_SECONDS = 10
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_ROWS = 5
MAX_PAGE = 20
# Only public, task-relevant title attributes. No owner/contact/household data.
ITEM_FIELDS = (
    "mgmBldrgstPk", "bldNm", "platPlc", "newPlatPlc", "sigunguCd", "bjdongCd",
    "platGbCd", "bun", "ji", "dongNm", "regstrGbCdNm", "regstrKindCdNm",
    "mainAtchGbCdNm", "mainPurpsCdNm", "strctCdNm", "roofCdNm", "platArea",
    "archArea", "totArea", "bcRat", "vlRat", "heit", "grndFlrCnt", "ugrndFlrCnt",
    "pmsDay", "stcnsDay", "useAprDay", "crtnDay",
)


class _RedirectBlocked(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Even same-host redirects are refused: credentials are never forwarded.
        if fp is not None:
            try:
                fp.close()
            except Exception:
                pass
        raise _RedirectBlocked()


def _make_opener():
    return urllib.request.build_opener(_NoRedirect())


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _allowed_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        return (parsed.scheme == "https" and parsed.hostname == "apis.data.go.kr"
                and parsed.port in (None, 443) and not parsed.username and not parsed.password
                and parsed.path == "/1613000/BldRgstHubService/getBrTitleInfo"
                and not parsed.fragment)
    except (ValueError, TypeError):
        return False


def _result(state, code, message, query, **extra):
    result = {"state": state, "code": code, "message": message,
              "source_url": SOURCE_URL, "fetched_at_utc": _timestamp(),
              "query": query, "items": [], "returned_count": 0,
              "live_request_made": False}
    result.update(extra)
    return result


def _safe_api_code(value):
    value = str(value) if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
    return value if re.fullmatch(r"[0-9]{1,4}", value) else ""


def _api_error(code, query):
    safe = _safe_api_code(code)
    if safe in {"20", "30", "31"}:
        return _result("error", "API_AUTH_ERROR", "공공데이터 인증키와 건축물대장 서비스 활용승인·이용기간을 확인해 주세요.", query,
                       api_result_code=safe, live_request_made=True)
    if safe in {"22", "23"}:
        return _result("error", "API_RATE_LIMIT", "공공데이터 API 호출 한도에 도달했습니다. 자동 재시도하지 않았습니다.", query,
                       api_result_code=safe, live_request_made=True)
    return _result("error", "API_ERROR", "공공데이터 서비스가 오류를 반환했습니다. 인증정보와 원문 오류는 출력하지 않습니다.", query,
                   api_result_code=safe, live_request_made=True)


def _xml_payload(raw):
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("XML entity declarations are not accepted")
    root = ET.fromstring(raw)
    def local(element):
        return element.tag.rsplit("}", 1)[-1]
    def convert(element):
        children = list(element)
        if not children:
            return element.text or ""
        result = {}
        for child in children:
            key, value = local(child), convert(child)
            if key in result:
                if not isinstance(result[key], list):
                    result[key] = [result[key]]
                result[key].append(value)
            else:
                result[key] = value
        return result
    return {local(root): convert(root)}


def _parse_payload(raw):
    clean = raw.lstrip(b"\xef\xbb\xbf \t\r\n")
    if clean.startswith(b"<"):
        return _xml_payload(raw)
    def reject_non_json_number(_):
        raise ValueError("Nonstandard JSON number")
    return json.loads(raw.decode("utf-8-sig"), parse_constant=reject_non_json_number)


def _normalize(data, query, service_key):
    if not isinstance(data, dict):
        raise ValueError("Object response required")
    gateway = data.get("OpenAPI_ServiceResponse")
    if isinstance(gateway, dict):
        header = gateway.get("cmmMsgHeader")
        if not isinstance(header, dict):
            raise ValueError("Gateway header required")
        return _api_error(header.get("returnReasonCode"), query)
    # The official Swagger describes header/body directly. The gateway may wrap
    # the same structure in response. Accept both without guessing item contents.
    response = data.get("response", data)
    if not isinstance(response, dict) or not isinstance(response.get("header"), dict):
        raise ValueError("Header required")
    code = _safe_api_code(response["header"].get("resultCode"))
    if code != "00":
        return _api_error(code, query)
    body = response.get("body")
    if not isinstance(body, dict):
        raise ValueError("Body required")
    total = body.get("totalCount")
    if isinstance(total, bool) or not isinstance(total, (str, int)) or not re.fullmatch(r"[0-9]{1,12}", str(total)):
        raise ValueError("Nonnegative totalCount required")
    total = int(total)
    items = body.get("items")
    if isinstance(items, dict):
        items = items.get("item", [] if total == 0 else None)
    if items in (None, "") and total == 0:
        items = []
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError("Items required")
    # Do not call contradictory/malformed data a successful zero-result query.
    if (total == 0 and items) or (total > 0 and not items and query["page_no"] == 1):
        raise ValueError("Count contradicts items")
    safe_items = []
    key_forms = {service_key, urllib.parse.quote(service_key, safe=""), urllib.parse.quote_plus(service_key)}
    for item in items[:query["num_of_rows"]]:
        safe = {}
        for field in ITEM_FIELDS:
            value = item.get(field)
            if not isinstance(value, (str, int, float)) or isinstance(value, bool):
                continue
            value = str(value)
            if len(value) > 1000:
                continue
            for key in key_forms:
                if key:
                    value = (value.replace(key, "[인증정보 제거]") if key == service_key
                             else re.sub(re.escape(key), "[인증정보 제거]", value, flags=re.IGNORECASE))
            safe[field] = value
        if not safe:
            raise ValueError("No recognized title fields")
        safe_items.append(safe)
    has_more = query["page_no"] * query["num_of_rows"] < total or len(items) > query["num_of_rows"]
    return _result("live" if safe_items else "no_data", "OK" if safe_items else "NO_DATA",
                   "공식 건축물대장 API에서 해당 페이지를 조회했습니다. 전체 현황·법규 적합성을 확정하는 자료는 아닙니다." if safe_items
                   else "조회 조건과 해당 페이지에 반환된 자료가 없습니다. 다른 주소·시점·전체 자료의 부재를 뜻하지 않습니다.",
                   query, items=safe_items, returned_count=len(safe_items), total_count=total,
                   has_more=has_more, partial=query["page_no"] > 1 or has_more,
                   api_result_code=code, live_request_made=True)


def lookup_building_title(sigungu_cd, bjdong_cd, plat_gb_cd="0", bun="", ji="",
                          page_no=1, num_of_rows=3, service_key=None) -> dict:
    """Make at most one fixed-host GET. No retry and no automatic demo fallback."""
    query = {}
    if (not isinstance(sigungu_cd, str) or not re.fullmatch(r"[0-9]{5}", sigungu_cd)
            or not isinstance(bjdong_cd, str) or not re.fullmatch(r"[0-9]{5}", bjdong_cd)
            or plat_gb_cd not in ("0", "1", "2")
            or not isinstance(bun, str) or (bun and not re.fullmatch(r"[0-9]{4}", bun))
            or not isinstance(ji, str) or (ji and not re.fullmatch(r"[0-9]{4}", ji))
            or type(page_no) is not int or not 1 <= page_no <= MAX_PAGE
            or type(num_of_rows) is not int or not 1 <= num_of_rows <= MAX_ROWS):
        return _result("error", "INVALID_QUERY", "시군구·법정동은 숫자5자리, 번·지는 비우거나 숫자4자리, 페이지1~20·행수1~5로 입력해 주세요.", query)
    query = {"sigungu_cd": sigungu_cd, "bjdong_cd": bjdong_cd, "plat_gb_cd": plat_gb_cd,
             "bun": bun, "ji": ji, "page_no": page_no, "num_of_rows": num_of_rows}
    if not isinstance(service_key, str) or not service_key.strip():
        return _result("setup_required", "SERVICE_KEY_REQUIRED", "로컬 인증키가 없습니다. 공공데이터포털 활용승인 후 개인 키 파일 또는 환경변수에 설정해 주세요. 예시 결과로 자동 전환하지 않았습니다.", query)
    # unquote, not unquote_plus: literal '+' in the real key must survive.
    key = urllib.parse.unquote(service_key.strip())
    if len(key) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in key):
        return _result("setup_required", "SERVICE_KEY_INVALID", "로컬 인증키 형식을 확인해 주세요. 키는 결과나 오류에 출력하지 않습니다.", query)
    params = {"serviceKey": key, "sigunguCd": sigungu_cd, "bjdongCd": bjdong_cd,
              "platGbCd": plat_gb_cd, "_type": "json", "pageNo": page_no, "numOfRows": num_of_rows}
    if bun:
        params["bun"] = bun
    if ji:
        params["ji"] = ji
    url = ENDPOINT + "?" + urllib.parse.urlencode(params)
    if not _allowed_url(url):
        return _result("error", "ENDPOINT_BLOCKED", "허용된 공식 API 주소가 아니어서 요청하지 않았습니다.", query)
    try:
        request = urllib.request.Request(url, method="GET", headers={"Accept": "application/json, application/xml", "User-Agent": "ZeroArchitect-Education-MCP/1.0"})
        with _make_opener().open(request, timeout=TIMEOUT_SECONDS) as response:
            if not _allowed_url(response.geturl()):
                raise _RedirectBlocked()
            status = response.getcode()
            if status != 200:
                return _result("error", "HTTP_ERROR", "공공데이터 서버가 정상 HTTP 응답을 반환하지 않았습니다. 자동 재시도하지 않았습니다.", query,
                               http_status=status if isinstance(status, int) and 100 <= status <= 599 else None, live_request_made=True)
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            return _result("error", "RESPONSE_TOO_LARGE", "응답이1MB 제한을 초과하여 처리하지 않았습니다. 조회 범위를 줄여 주세요.", query, live_request_made=True)
        return _normalize(_parse_payload(raw), query, key)
    except _RedirectBlocked:
        return _result("error", "REDIRECT_BLOCKED", "API가 이동을 요청하여 중단했습니다. 이동 대상에는 인증키를 전달하지 않았습니다.", query, live_request_made=True)
    except urllib.error.HTTPError as error:
        # HTTPError owns a response stream. Close it rather than leaving a
        # ResourceWarning whose exception repr could contain the credential URL.
        try:
            error.close()
        except Exception:
            pass
        if 300 <= error.code < 400:
            return _result("error", "REDIRECT_BLOCKED", "API 이동 응답을 차단했습니다. 이동 대상에는 인증키를 전달하지 않았습니다. 자동 재시도하지 않았습니다.", query, live_request_made=True)
        return _result("error", "HTTP_ERROR", "공공데이터 서버의 HTTP 오류입니다. URL·인증키·원문 오류는 출력하지 않습니다.", query,
                       http_status=error.code if 100 <= error.code <= 599 else None, live_request_made=True)
    except (TimeoutError, socket.timeout):
        return _result("error", "NETWORK_TIMEOUT", "공공데이터 API 응답 대기시간10초를 넘었습니다. 자동 재시도하지 않았습니다.", query, live_request_made=True)
    except urllib.error.URLError as error:
        timeout = isinstance(error.reason, (TimeoutError, socket.timeout))
        return _result("error", "NETWORK_TIMEOUT" if timeout else "NETWORK_ERROR", "공공데이터 API에 연결하지 못했습니다. 네트워크와 서비스 상태를 확인해 주세요. 자동 재시도하지 않았습니다.", query, live_request_made=True)
    except (ValueError, TypeError, ET.ParseError, UnicodeError):
        return _result("error", "INVALID_RESPONSE", "공공데이터 응답 구조를 확인하지 못했습니다. 원문·인증키는 출력하지 않습니다.", query, live_request_made=True)
    except Exception:
        return _result("error", "CLIENT_ERROR", "조회 처리 중 오류가 발생했습니다. 인증키·URL·오류 상세는 출력하지 않습니다. 자동 재시도하지 않았습니다.", query, live_request_made=True)
