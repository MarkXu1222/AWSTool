-- AWS Console Launcher
-- 注册 awsconsole:// URL scheme，接收平台网页的调用并转交 launch.sh。
-- macOS 只把自定义 scheme 的 URL 通过 Apple Event 投递给应用，
-- 纯 shell 脚本收不到，所以这里用 AppleScript 应用的 open location 处理器。

on open location this_URL
	try
		set myPath to POSIX path of (path to me)
		set sh to myPath & "Contents/Resources/launch.sh"
		do shell script quoted form of sh & " " & quoted form of this_URL
	on error errMsg
		display notification errMsg with title "AWS Console Launcher"
	end try
end open location

on run
	display dialog "AWS Console Launcher 已就绪。

它由平台「控制台」按钮自动调用，不需要手动运行。
每个 AWS 账户会用独立的浏览器会话打开，可同时登录多个账户。" buttons {"好"} default button 1 with title "AWS Console Launcher"
end run
