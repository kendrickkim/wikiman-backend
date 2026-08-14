# DokuWiki → Wikiman 가져오기

[wiki.love-02.com](http://wiki.love-02.com/) 같은 **DokuWiki** 데이터를 SFTP로 받은 뒤 Wikiman으로 넣습니다.

## 1. SFTP로 받기

서버에서 보통 아래 두 폴더가 필요합니다.

| 원격 (DokuWiki) | 로컬 |
| --- | --- |
| `.../data/pages/` | `backend/data/dokuwiki/pages/` |
| `.../data/media/` | `backend/data/dokuwiki/media/` |

예 (OpenSSH `sftp` / FileZilla / WinSCP):

```text
data/dokuwiki/
  pages/     ← 문서 .txt
  media/     ← 이미지·첨부
```

`DOKUWIKI_ROOT`를 `data/dokuwiki`의 **부모인 data가 아니라** `pages`와 `media`가 들어 있는 그 폴더로 두면 됩니다.

## 2. Wikiman API 실행

```bash
cd backend
npm run dev
```

API 기본 포트는 `85` 입니다.

## 3. 가져오기

```powershell
cd backend
npm run import:dokuwiki -- --dry-run
npm run import:dokuwiki
```

실행하면 아래를 입력받습니다.

- DokuWiki 경로 (기본: `backend/data/dokuwiki`)
- Wikiman API URL (기본: `http://localhost:85`)
- 사용자 아이디 / 비밀번호

환경 변수 `DOKUWIKI_ROOT`, `WIKIMAN_API`, `WIKIMAN_USER`, `WIKIMAN_PASS`가 있으면 기본값으로 쓰입니다.

- `--dry-run` : 업로드·글 저장 없이 대상만 확인
- `--limit=10` : 앞에서 10개만

## 동작 요약

- `pages/**/*.txt` → Markdown 글로 변환 후 `POST /api/posts`
- 네임스페이스(`amlogic:foo`) → 카테고리 트리
- `private:` 로 시작하면 카테고리 **비공개**
- `{{:이미지}}` → 미디어 업로드 후 본문 URL 교체
- `start` 문서는 홈페이지 글로 지정

## 한계

- DokuWiki 전용 플러그인·복잡한 매크로는 수동 수정이 필요할 수 있습니다
- 문서 간 링크는 `#doku:페이지id` 형태로 남습니다 (가져오기 후 필요하면 손보기)
- 같은 문서를 여러 번 실행하면 **글이 중복**됩니다 (한 번만 실행하거나 휴지통에서 정리)
