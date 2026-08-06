# OrderAssistPrint - portable office print kit
#
# Run this on the OFFICE PC that can reach the printer (same LAN / Wi-Fi as HP ENVY).
# Do NOT run the agent from a laptop that is off the office network.
#
# Shared kit path (office): H:\Printer\OrderAssistPrint
#   start_agent.bat or start_agent_hidden.bat -> start/restart the agent after updates
#
# A (production): drivers installed on THIS PC once.
#    Frontend (Printers page) finds/controls every printer via this agent.
#
# Layout:
#   start_agent.bat / start_agent_hidden.bat
#   print_agent.ps1      -> talks to OrderAssist frontend / API
#   SumatraPDF.exe       -> required for reliable PDF printing
#   config.json          -> BaseUrl (https://orderassistnow.com:3000)
#   token.txt            -> agent token from Printers > Agent tab
#   drivers\<PrinterName>\
#   outbox\
#
# Shipping printer Windows name must match exactly, e.g.:
#   HP4B5CF1 (HP ENVY 5660 series)
#   (Albert office in the UI is mapped to that Windows name)
#
# After updating files on H:\Printer\OrderAssistPrint, restart the agent on the office PC.

# SumatraPDF is copied to %LOCALAPPDATA%\OrderAssistPrint\ on start
# so Windows does not show Run prompts from the H: network path.
