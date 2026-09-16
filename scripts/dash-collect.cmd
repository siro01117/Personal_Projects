@echo off
rem 작업 스케줄러가 부르는 진입점. node 를 직접 등록하면 작업 폴더가 안 잡혀서
rem .env.local 과 node_modules 를 못 찾는다 — 여기서 레포로 이동한 뒤 부른다.
rem chcp 65001 이 없으면 한글 출력이 OEM 코드페이지로 찍혀 로그가 깨진다.
chcp 65001 >nul
cd /d "%~dp0.."
echo [%date% %time%] >> "%TEMP%\dash-collect.log"
node scripts\dash-collect.mjs >> "%TEMP%\dash-collect.log" 2>&1
