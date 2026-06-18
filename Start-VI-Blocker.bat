@echo off
setlocal
color 0A
title VI Number Blocker - Startup

echo ========================================================
echo        VI Number Blocker Automation Tool
echo ========================================================
echo.

:: Check if Node.js is installed
node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed on this computer!
    echo Please download and install it from: https://nodejs.org/
    echo.
    echo Press any key to exit...
    pause >nul
    exit /b
)

:: Ensure browsers are downloaded locally to make the folder portable
set PLAYWRIGHT_BROWSERS_PATH=0

:: Check if node_modules exists (First time setup)
if not exist "node_modules\" (
    echo [SETUP] First time setup detected! Installing required dependencies...
    echo This may take a few minutes depending on your internet connection.
    call npm install
    echo.
    echo [SETUP] Dependencies installed successfully!
)

:: Start the server in the background and wait 2 seconds
echo [SERVER] Starting the backend server...
start /B node server.js

:: Give the server a moment to start
timeout /t 2 /nobreak >nul

:: Open the frontend UI in the default browser
echo [UI] Opening the Application in your browser...
start http://localhost:3000

echo.
echo ========================================================
echo  The application is running! 
echo  Please DO NOT close this black window while using the app.
echo  To stop the application, press CTRL+C or close this window.
echo ========================================================
echo.

:: Keep the terminal window open to show logs
pause
