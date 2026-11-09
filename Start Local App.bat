@echo off
rem ---------------------------------------------------------------------------
rem  Convenience launcher for the offline app in the "local" folder.
rem
rem  The local app can read the jee folder straight off this PC, so it also has
rem  the "recently opened" shelf and the "open in Acrobat / show in Explorer"
rem  buttons that the hosted version cannot have. It never touches the network.
rem
rem  Everything else (finding Python, keeping the window open on failure) lives
rem  in the real launcher, which is simply handed over to below.
rem ---------------------------------------------------------------------------
call "%~dp0local\Start JEE Browser.bat"
