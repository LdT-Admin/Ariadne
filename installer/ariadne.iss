; Ariadne — установщик (Inno Setup 7).
; Режимы: «Установить» (ярлыки + деинсталлятор) и «Портативная версия» (распаковка в папку).
; Сборка: ISCC.exe ariadne.iss

#define MyAppName "Ariadne"
#define MyAppVersion "0.3.1"
#define MyAppExeName "Ariadne.exe"

[Setup]
AppId={{9E64B4C1-7C0A-4E8B-9A4F-2D5C6Ari7100}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=LdT-Admin
DefaultDirName={code:GetDefaultDir}
DefaultGroupName={#MyAppName}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=installer
OutputBaseFilename=Ariadne-{#MyAppVersion}-Setup
SetupIconFile=..\assets\branding\app-icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
ChangesAssociations=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; Check: IsInstallMode

[Files]
Source: "..\..\Ariadne.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\*"; Excludes: "Ariadne.exe,data,data\*,Sessions,Sessions\*,Sessions-перенос,Sessions-перенос\*,src,src\*,*.bak,*.log,LOGO.md,out.txt,err.txt,shots,shots\*,.scratch,.scratch\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Check: IsInstallMode
Name: "{group}\Удалить {#MyAppName}"; Filename: "{uninstallexe}"; Check: IsInstallMode
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; Check: IsInstallMode

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Запустить {#MyAppName}"; Flags: nowait postinstall skipifsilent; Check: IsInstallMode

[Code]
var
  ModePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  ModePage := CreateInputOptionPage(wpWelcome,
    'Режим установки',
    'Как установить ' + '{#MyAppName}' + '?',
    'Выберите один из вариантов и нажмите «Далее»:', True, False);
  ModePage.Add('Установить — ярлыки в меню «Пуск» и на рабочем столе, удаление через «Установка и удаление программ»');
  ModePage.Add('Портативная версия — просто распаковать в выбранную папку, без следов в системе');
  ModePage.Values[0] := True;
end;

function IsInstallMode: Boolean;
begin
  Result := ModePage.Values[0];
end;

function GetDefaultDir(Param: String): String;
begin
  if Assigned(ModePage) and ModePage.Values[1] then
    Result := ExpandConstant('{userdesktop}\Ariadne')
  else
    Result := ExpandConstant('{localappdata}\Programs\Ariadne');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // Портативная версия: убрать следы установки (деинсталлятор и запись в реестре)
  if (CurStep = ssPostInstall) and (not IsInstallMode) then
  begin
    DeleteFile(ExpandConstant('{uninstallexe}'));
    DeleteFile(ExpandConstant('{app}\unins000.dat'));
    RegDeleteKeyIncludingSubkeys(HKEY_CURRENT_USER,
      'Software\Microsoft\Windows\CurrentVersion\Uninstall\{9E64B4C1-7C0A-4E8B-9A4F-2D5C6Ari7100}_is1');
  end;
end;
