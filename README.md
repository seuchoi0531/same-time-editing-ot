# OT 실시간 공동 편집 데모

서버가 문서와 리비전 이력을 갖고, 늦게 도착한 삽입·삭제 연산을 이미 반영된 연산에 대해 변환(Operational Transformation)하는 발표용 웹 앱입니다.

## 실행

```powershell
npm install
npm start
```

브라우저에서 `http://localhost:3000?room=발표방이름`을 열고, 같은 주소를 여러 창에서 엽니다. 방 이름이 같으면 같은 문서를 편집합니다.

## 온라인 발표 배포

이 폴더를 하나의 Git 저장소로 올린 뒤 Render의 **Web Service**로 연결하면 됩니다.

| 설정 | 값 |
| --- | --- |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |

`PORT` 환경 변수는 배포 플랫폼이 주입한 값을 자동 사용합니다. 배포된 `https://.../?room=ot-presentation` 링크를 참가자에게 공유하면 서로 다른 Wi-Fi에서도 같은 방에 접속합니다.

> 서버 메모리는 실행 중에만 유지됩니다. 발표 전 새 방 이름을 사용하면 빈 문서로 시작할 수 있습니다.

## 발표 시연 제안

두 사람이 같은 문서의 첫 위치에 동시에 다른 글자를 입력합니다. 오른쪽 **연산 흐름**과 **서버 리비전**을 보면서, 서버가 연산 위치를 변환해 하나의 순서를 정하는 과정을 설명하면 됩니다.
