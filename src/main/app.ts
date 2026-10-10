import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  BrowserWindow,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  webContents,
} from 'electron'
import type { IPty } from 'node-pty'
import appIcon from '../../resources/icon.png?asset'
import type { AgentResume } from '../shared/agents/agentResume'
import type { HibernateOutcome } from '../shared/agents/agentWork'
import {
  MANAGER_FEATURE,
  managerAgents,
  parseManagerSettings,
} from '../shared/agents/managerSettings'
import { fmt } from '../shared/app/dict'
import type { DiscreteGpuInfo } from '../shared/app/discreteGpu'
import { clampZoom, zoomFactor } from '../shared/app/zoom'
import { appEnv } from '../shared/appEnv'
import { ARTIFACT_LIST_MAX } from '../shared/artifacts/artifacts'
import { isPreviewPartition } from '../shared/artifacts/htmlPreview'
import { parseChatToolSettings } from '../shared/assist/chatTools'
import { parseGitSettings } from '../shared/boards/git'
import { parsePortsSettings } from '../shared/boards/ports'
import { SHARED_BROWSER_PARTITION, browserPartition } from '../shared/browser/browserProfile'
import { MANAGER_CAPABILITIES } from '../shared/capabilities'
import { languageForPath } from '../shared/editorLanguages'
import type {
  ExtensionEventPayloads,
  ExtensionEventType,
  ExtensionPanelContext,
  ExtensionResult,
  WorkspaceChip,
} from '../shared/extensions'
import { EXTENSION_SUGGESTIONS } from '../shared/extensions/extensionSuggestions'
import { OPEN_FILES_COMMAND } from '../shared/files/openFiles'
import { OPEN_FILES_MAX } from '../shared/files/openFiles'
import { desktopsOf } from '../shared/keyboard/desktopChords'
import { languageServerKey } from '../shared/languageServers'
import { parsePrivacySettings } from '../shared/privacy/redaction'
import { bucketCount } from '../shared/privacy/telemetry'
import { OFFICIAL_MARKETPLACE, PRODUCT_NAME } from '../shared/product'
import { PRODUCT_DISPLAY_NAME } from '../shared/productDisplay'
import { type RemoteCwd, normalizeRemoteCwd } from '../shared/remoteFolders'
import { parseSandboxGlobals } from '../shared/sandbox/sandbox'
import {
  KEEP_SHELLS_FEATURE,
  KEPT_SHELLS_DIR,
  parseKeepShells,
} from '../shared/terminal/keepShells'
import { isHostNamed } from '../shared/terminal/osc7'
import { quoteArg, quoteArgv } from '../shared/terminal/shellQuote'
import { shellArgv, shellName } from '../shared/terminal/terminalShell'
import type {
  AppInfo,
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  ExternalEditorRequest,
  FsEntry,
  FsKind,
  LifecycleEvent,
  PaneActivity,
  PromptContext,
  PromptContextRequest,
  PtyAttachResult,
  PtySpawnOptions,
  TerminalStateSnapshot,
  WindowBounds,
} from '../shared/types'
import { AGENT_OFFER_RESULT_CHANNEL, createAgentOfferRelay } from './agents/agentOfferRelay'
import { AgentRunningPanes } from './agents/agentRunning'
import { agentPluginContent } from './agents/agentSkills'
import { registerAgentTranscriptIpc } from './agents/agentTranscript'
import {
  ReportedAgentWork,
  backgroundWork,
  readProcessTable,
  registerAgentWorkMethods,
} from './agents/agentWork'
import { registerBusMethods } from './agents/bus'
import type { OriginReach } from './agents/originAgents'
import { approvals, registerApprovals } from './approvals/approvals'
import { createAskHub } from './approvals/asks'
import {
  dropIdentity,
  loadReachMode,
  refreshCapabilitySettings,
  setCaps,
} from './approvals/capabilityStore'
import { registerPermissionAsk } from './approvals/permissionAsk'
import { questions, registerQuestions } from './approvals/questions'
import { type ReachListing, createReach } from './approvals/reach'
import {
  checkScriptToken,
  recordCreatedWorkspace,
  registerScriptTokenMethods,
  retireLegacyScriptTokens,
  scriptTokenScope,
} from './approvals/scriptTokens'
import { ArtifactCompiler } from './artifacts/artifactCompiler'
import { ArtifactFolders, registerArtifactIpc } from './artifacts/artifactFolders'
import { loadEsbuild } from './artifacts/esbuildService'
import {
  PreviewHost,
  type PreviewSession,
  hardenPreviewAttach,
  registerPreviewIpc,
} from './artifacts/htmlPreview'
import { registerAttentionMethods, targetOf } from './attention/attention'
import { announceBusMessage } from './attention/busNotice'
import {
  postActionNotification,
  postNotification,
  postPanelNotification,
  registerNotifyIpc,
  registerNotifyMethods,
} from './attention/notify'
import {
  type ConsoleEntry,
  OSTIA_ERROR_PREFIX,
  PAGE_ERROR_CATCHER_JS,
  clearGuestBrowseState,
  ownedGuest,
  pushConsoleEntry,
  registerBrowseMethods,
} from './browser/browse'
import { cancelPick, registerPickIpc, registerPickMethods } from './browser/browsePick'
import { registerRegionIpc } from './browser/browseRegion'
import { BrowserProfiles } from './browser/browserProfiles'
import { registerBrowserStorageIpc } from './browser/browserStorage'
import { browserUserAgent } from './browser/browserUserAgent'
import { credentials, registerCredentials } from './browser/credentials'
import { type GuestChords, registerGuestChords } from './browser/guestChords'
import { clearGuestNetwork, forgetGuestNetwork, watchGuestNetwork } from './browser/guestNetwork'
import { registerLoginFill } from './browser/loginFill'
import { registerAssistIpc } from './chat/assistIpc'
import { createChatSessionStore } from './chat/chatSessions'
import { registerChatSessionIpc } from './chat/chatSessionsIpc'
import { ChatToolGrants } from './chat/chatToolGrants'
import { registerChatToolsIpc } from './chat/chatToolsIpc'
import { McpHost } from './chat/mcpHost'
import { McpOAuth, mcpOAuthBrowser } from './chat/mcpOAuth'
import { createMcpOAuthStore } from './chat/mcpOAuthStore'
import { setCapFilter, setScriptTokenCheck } from './control/controlAuth'
import { clearControlInfo, controlInfoPath, writeControlInfo } from './control/controlDiscovery'
import {
  controlSocketPath,
  keptControlSocketPath,
  listenKeptControlSocket,
  registerControlServer,
  stopControlServer,
} from './control/controlServer'
import { registerDocsMethods } from './control/docs'
import { emitPlatformEvent, emitSessionState, platformEvents } from './control/events'
import {
  type PaneIdentity,
  adoptPane,
  getByPaneId,
  markManager,
  moveToWorkspace,
  panesOwnedBy,
  registerPane,
  rehomeWorkspace,
  removePane,
  removeWindow,
  resolveExternal,
  setPaneIdSalt,
  windowOfWorkspace,
  workspaceHasManager,
} from './control/idRegistry'
import { loadPaneIdSalt } from './control/paneIdSalt'
import { type AppLog, LOG_FILE_NAME, createAppLog } from './diagnostics/appLog'
import { type Diagnostics, registerDiagnostics } from './diagnostics/diagnostics'
import {
  type SessionFacts,
  TELEMETRY_FILE,
  type Telemetry,
  registerTelemetry,
} from './diagnostics/telemetry'
import { confirmForExtension } from './extensions/extensionConfirm'
import { ExtensionHost, registerExtensionMethods } from './extensions/extensionHost'
import type { ExtensionRoot } from './extensions/extensionManifest'
import { type SecretStoreDeps, createSecretStore } from './extensions/extensionSecrets'
import { ExtensionStore } from './extensions/extensionStore'
import { DismissedSuggestions, suggestionFor } from './extensions/extensionSuggestions'
import { registerIconThemeIpc } from './extensions/iconThemes'
import { describeSkipped, registerKeymapIpc } from './extensions/keymaps'
import { registerLanguagePackIpc } from './extensions/languagePacks'
import { Marketplace, marketplaceId, normalizeMarketplaceUrl } from './extensions/marketplace'
import { createMainStrings } from './extensions/strings'
import { firstKnownOwner, workspaceChipsForWindow } from './extensions/workspaceChips'
import { openInExternalEditor } from './files/externalEditor'
import { FileOps } from './files/fileOps'
import { FileWatches, TreeWatches } from './files/fileWatch'
import { readBinaryConfined } from './files/fsBinary'
import { readTextConfined, versionConfined, writeText } from './files/fsText'
import { OpenFileGrants } from './files/openFileGrants'
import { openFileForExtension, registerOpenFileMethods } from './files/openFileMethods'
import { registerOpenPathIpc } from './files/openPath'
import { OpenWaits } from './files/openWaits'
import { confirmRemoteFolder, registerRemoteFolderConfirm } from './files/remoteFolderConfirm'
import type { RemoteFolders } from './files/remoteFolders'
import { ripgrepPath } from './files/ripgrep'
import { registerSearchIpc } from './files/workspaceSearch'
import {
  configureAnnouncer,
  configureTailnet,
  onTailnetChange,
  registerGatewayIpc,
  registerGatewayMethods,
} from './gateway'
import { createBonjourPublisher } from './gateway/announce'
import { listPairRequests, onPairRequestsChanged } from './gateway/pairRequests'
import { configureGatewayControl, phoneCanRespond, stopGateway } from './gateway/server'
import { createTailnet, tailnetNodeName, tsnetHelperPath } from './gateway/tailnet'
import type { PhoneFileScope } from './gateway/workspaceFiles'
import { GitCommands } from './git/commands'
import { confirmDiscard } from './git/confirmDiscard'
import { registerGitIpc, registerGitMethods } from './git/register'
import { GitService } from './git/service'
import { ViewStateStore } from './git/viewState'
import { registerEditorLanguageIpc } from './lsp/editorLanguages'
import { LanguageServers, scrubbedEnv } from './lsp/languageServers'
import { registerLanguageServersIpc } from './lsp/languageServersIpc'
import { ManagedServers, downloadBaseUrl } from './lsp/managedServers'
import { ServerOverrides } from './lsp/serverOverrides'
import { ManagerService, managerWindowId } from './manager/manager'
import {
  managerArgv,
  writeManagerClaudePlugin,
  writeManagerCodexContext,
} from './manager/managerAgent'
import { type ManagerLimiter, registerManagerMethods } from './manager/managerMethods'
import {
  type MirrorHandle,
  type MirrorSink,
  Portal,
  portalSocketPath,
  portalSupported,
} from './manager/portal'
import { callerVerdict, procFs, ttysOf } from './manager/portalCaller'
import {
  type PaneAttentionPeek,
  type PaneIo,
  type PaneReachDeps,
  pastedText,
  registerPaneIoMethods,
} from './panes/paneIo'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  registerPaneListMethods,
} from './panes/paneList'
import { registerPaneMoveIpc } from './panes/paneMove'
import { registerPaneMoveToMethods } from './panes/paneMoveTo'
import type { PaneProcess } from './panes/paneProcess'
import { registerPaneRenameMethods } from './panes/paneRename'
import { registerPaneResumeMethods } from './panes/paneResume'
import { PaneWatch, registerPaneWaitMethods } from './panes/paneWait'
import { PaneWaking } from './panes/paneWaking'
import {
  INTERRUPT_GRACE_MS,
  type ProcessRegistry,
  type ProcessTabRequest,
  registerProcessMethods,
} from './panes/processManager'
import { discreteGpu, gpuStartPlan, querySwitcherooGpus } from './platform/discreteGpu'
import { loadJson, saveJson, storePath } from './platform/jsonStore'
import { resolveSafe } from './platform/pathGuard'
import { privateTmpDir } from './platform/privateTmp'
import { needsPtyRelay } from './platform/ptyRelay'
import {
  SANDBOX_FEATURE,
  installHint,
  missingRequirements,
  onPath,
  programPath,
  registerRequirements,
  requirementLabel,
} from './platform/systemRequirements'
import { registerSystemRequirementsIpc } from './platform/systemRequirementsIpc'
import {
  OLD_PRODUCT_NAME,
  appConfigDir,
  appDataDir,
  configHome,
  dataHome,
} from './platform/userDirs'
import { registerPortsIpc, registerPortsMethods } from './ports/register'
import { PortsService } from './ports/service'
import { registerPrivacyIpc } from './privacy/privacyIpc'
import { createRedactor, createScrollbackRedactor } from './privacy/redaction'
import { createWorkerScan, redactionWorkerScript } from './privacy/redactionScan'
import { type ProfileSyncHandle, startProfileSync } from './profileSync/ipc'
import { flatSource, groupedSource, loginsSource } from './profileSync/secrets'
import { attachWorkspace } from './sandbox/attachWorkspace'
import { BrowserFence } from './sandbox/browserFence'
import { registerSandboxMethods } from './sandbox/controlMethods'
import { DomainRequests } from './sandbox/domainRequests'
import { HostPaneGrants } from './sandbox/hostPanes'
import { registerSandboxIpc } from './sandbox/ipc'
import { packageCooldownEnv } from './sandbox/packageEnv'
import { PackageRequests } from './sandbox/packageRequests'
import { PortBridge, bridgesPorts } from './sandbox/portBridge'
import { PortForwarder, type SandboxListener, type SandboxPane } from './sandbox/portForwarder'
import { PortRequests } from './sandbox/portRequests'
import { HOST_PROTOCOL_VERSION } from './sandbox/protocol'
import { relayForced, sandboxedShellCommand, wrapForTerminal } from './sandbox/ptyWrap'
import { hiddenHomeNotice, sandboxFailureBanner } from './sandbox/spawnBanner'
import { sandboxSpawnEnv } from './sandbox/spawnEnv'
import { reportSandboxSpawnFailure } from './sandbox/spawnFailureNotice'
import { type SandboxBasePaths, reachableContainerSockets, srtVendorDir } from './sandbox/srtConfig'
import { SandboxStore } from './sandbox/store'
import { ViolationLog, recordViolations } from './sandbox/violations'
import {
  type SandboxReadRules,
  sandboxEntries,
  sandboxPath,
  visibleInSandbox,
} from './sandbox/visibility'
import { SandboxUnavailableError, WorkspaceSandboxes } from './sandbox/workspaceSandboxes'
import { registerSecretMethods } from './secrets/register'
import { prepareSecrets } from './secrets/secretInjection'
import { SecretService } from './secrets/secretService'
import {
  deleteGlobalVaultValue,
  registerVaultMethods,
  setGlobalVaultValue,
  vaultKeys,
  vaultValue,
} from './secrets/vault'
import { WorkspaceAgents } from './secrets/workspaceAgents'
import { registerCompletionIpc } from './terminal/completionSpecs'
import { atLocalPrompt, busyProgram } from './terminal/localPrompt'
import { replaceFile, writeOstiaLauncher } from './terminal/paneLauncher'
import { KubeContextReader, NodeVersionResolver, promptContext } from './terminal/promptContext'
import { CoalescedOutput, PtyFlowControl } from './terminal/ptyFlow'
import { type ReapReason, RecoveryBook, orphanVerdict, planRecovery } from './terminal/ptyReaper'
import { PtySession, type Subscriber, type SubscriberRole } from './terminal/ptySession'
import { HIBERNATE_SEAM, HISTORY_LINES, RESTORE_SEAM, ScreenMirror } from './terminal/screenMirror'
import { registerSelectionIpc } from './terminal/selectionReport'
import { ExecutableIndex, commandNames, readShellState } from './terminal/shellCommands'
import { closesPaneOnExit } from './terminal/shellExit'
import {
  INTEGRATION_DIR,
  setAgentPlugins,
  shellIntegrationSpawnOptions,
} from './terminal/shellIntegration'
import { sandboxCwd, spawnFolder } from './terminal/spawnCwd'
import {
  type PaneOutput,
  TerminalPathLinks,
  registerTerminalPathLinkIpc,
} from './terminal/terminalPathLinks'
import {
  PTY_COLOR_ENV,
  PTY_TERM_NAME,
  paneShellEnv,
  ptyIdentityEnv,
  withPaneToken,
} from './terminal/terminalType'
import { type SavedAttention, isKeptAttentionState } from './tmux/attentionFile'
import { SANDBOX_NOT_KEPT, TMUX_MISSING, keepShellsNotice } from './tmux/keepShellsBanner'
import { KeptAttention } from './tmux/keptAttention'
import {
  type KeptHostMeta,
  type KeptMeta,
  type KeptProcessMeta,
  type KeptProgram,
  type KeptShell,
  KeptShells,
  SANDBOX_HOST_KIND,
} from './tmux/keptShells'
import type { TmuxPane } from './tmux/tmuxServer'
import { registerAppUpdate } from './updates/appUpdate'
import { appVersion, runningBuild } from './updates/appVersion'
import { installAppDir, installMethod } from './updates/installMethod'
import {
  type PendingSweep,
  canReplaceInstall,
  createInstallReplacer,
  releaseDownloadBase,
  runTar,
  sweepOldInstall,
} from './updates/installReplace'
import {
  announceReplace,
  announceReplaceProgress,
  announceUpdateRun,
  registerReleaseCheck,
  releaseUserAgent,
} from './updates/releaseCheck'
import { type UpdateRunner, createUpdateRunner } from './updates/updateRun'
import { installAppMenu } from './windows/appMenu'
import { type ClipboardEdits, registerClipboardEdits } from './windows/clipboardEdits'
import { confirmQuit, freezeAll, registerCloseGuard } from './windows/closeGuard'
import { attachContextMenu } from './windows/contextMenu'
import { GlobalHotkey, toggleWindows } from './windows/globalHotkey'
import { acceptsPrimarySelection } from './windows/primarySelection'
import {
  QUIT_SIGNALS,
  createQuitTrace,
  exitAfterDeadline,
  keptOnQuit,
  planQuit,
  summarizeKinds,
} from './windows/quitPlan'
import { confirmQuitNatively } from './windows/quitPrompt'
import {
  AppTray,
  closeAction,
  isHiddenLaunch,
  readCloseToTray,
  unreadWorkspaces,
} from './windows/tray'
import { MAIN_SLOT } from './windows/windowBook'
import { WindowBroker } from './windows/windowBroker'
import { registerCmuxSessionIpc } from './workspaces/cmuxSession'
import { registerProjectRootIpc } from './workspaces/projectRoot'
import { ScratchFolders, registerScratchIpc } from './workspaces/scratchFolders'
import { ViewHost, ViewStore } from './workspaces/viewHost'
import { registerViewMethods, registerViewsIpc } from './workspaces/viewsIpc'
import {
  type WorkflowDeps,
  registerWorkflowIpc,
  registerWorkflowMethods,
} from './workspaces/workflows'
import { registerWorkspaceMergeIpc } from './workspaces/workspaceMerge'
import {
  removeWorkspace,
  setWorkspaceWorkDir,
  windowForWorkspace,
  workDirForWorkspace,
} from './workspaces/workspaceRegistry'
import {
  type RestoreOutcome,
  dropRestoredScrollback,
  handoffPaneIds,
  loadRestoredScrollback,
  loadSnapshot,
  pendingRestoredScrollback,
  saveScrollback,
  scrollbackToSave,
  stashScrollback,
  stashedScreen,
  takeRestoredScrollback,
} from './workspaces/workspaceSnapshot'

const devServerUrl = process.env.ELECTRON_RENDERER_URL

let ptyModule: typeof import('node-pty') | null | undefined
function loadPty(): typeof import('node-pty') | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('node-pty')
    } catch (err) {
      console.error('[pty] node-pty unavailable — terminals disabled. Run: npm run rebuild', err)
      ptyModule = null
    }
  }
  return ptyModule ?? null
}

interface PtyEntry {
  paneId: string
  pty: PaneProcess
  kept: TmuxPane | null
  keptMeta: KeptMeta | null
  session: PtySession
  flow: PtyFlowControl
  mirror: ScreenMirror
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
  workspaceId: string
  sandboxed: boolean
  shell: string
  sandboxStamp: string | null
  portBridge: PortBridge | null
  confinedBy: string | null
  keepAlive: boolean
  exitListeners: Set<(code: number) => void>
}

const ptys = new Map<string, PtyEntry>()
const PTY_BUFFER_CAP = 1_000_000
const executables = new ExecutableIndex()
const promptSources = { node: new NodeVersionResolver(), kube: new KubeContextReader() }

function listDir(dir: string): FsEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  } catch {
    return []
  }
}

function holdsLocalPrompt(entry: PtyEntry): boolean {
  return atLocalPrompt({
    foreground: entry.pty.process,
    shell: entry.shell,
    sandboxed: entry.sandboxed,
  })
}

function paneActivity(entry: PtyEntry): PaneActivity {
  let program: string | null = null
  try {
    program = busyProgram({
      foreground: entry.pty.process,
      shell: entry.shell,
      sandboxed: entry.sandboxed,
    })
  } catch {
    program = null
  }
  return { program, agentRunning: agentRunning.has(entry.paneId) }
}

function sandboxReadRules(entry: PtyEntry): SandboxReadRules | null {
  if (!entry.sandboxed) return null
  try {
    const { denyRead, allowRead } = workspaceSandboxes.config(entry.workspaceId).filesystem
    return { denyRead, allowRead }
  } catch {
    return { denyRead: ['/'], allowRead: [] }
  }
}

function removeStateFile(entry: PtyEntry): void {
  rmSync(entry.stateFile, { force: true })
}

const SANDBOX_LOST_WHILE_AWAY = `its sandbox ended while ${PRODUCT_DISPLAY_NAME} was closed`

const hibernatedPanes = new Set<string>()
const movingPanes = new Set<string>()

const recovery = new RecoveryBook()
const recoveryHeld = new Set<string>()
const closedPanes = new Set<string>()
let appLog: AppLog | null = null
let diagnostics: Diagnostics | null = null
let telemetry: Telemetry | null = null
let restoreOutcome: RestoreOutcome = 'none'

function telemetrySessionFacts(): SessionFacts {
  const settings = readSettingsFile() as {
    behavior?: { inputMode?: unknown; gpuAcceleration?: unknown }
    terminal?: { renderer?: unknown; prompt?: { style?: unknown } }
  }
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback
  const installed = marketplaceInstallIds()
  const enabled =
    extensionHost
      ?.list()
      .filter((ext) => ext.enabled && installed.includes(ext.id))
      .map((ext) => ext.id) ?? []
  let workspaces = 0
  for (const win of windows.values()) {
    if (!win.isDestroyed()) workspaces += broker?.workspacesOf(win).length ?? 0
  }
  return {
    windows: bucketCount(windows.size),
    workspaces: bucketCount(workspaces),
    restore: restoreOutcome,
    inEffect: {
      features: {
        input_mode: text(settings.behavior?.inputMode, 'terminal'),
        prompt_style: text(settings.terminal?.prompt?.style, 'shell'),
      },
      terminal: {
        engine: text(settings.terminal?.renderer, 'xterm'),
        gpu: settings.behavior?.gpuAcceleration === false ? 'off' : 'on',
      },
    },
    installedExtensions: installed,
    enabledExtensions: enabled,
  }
}

function shellFamily(shell: string): string {
  const name = basename(shell).toLowerCase()
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : 'other'
}
const officialMarketplaceId = marketplaceId(normalizeMarketplaceUrl(OFFICIAL_MARKETPLACE) ?? '')
let marketplaceInstallIds: () => string[] = () => []
let telemetrySentForQuit = false
let sendingTelemetryForQuit = false
let processes: ProcessRegistry | null = null

function windowOfPane(paneId: string): string | undefined {
  return getByPaneId(paneId)?.windowId
}

function scheduleReap(paneId: string, entry: PtyEntry): void {
  if (entry.killTimer) clearTimeout(entry.killTimer)
  entry.killTimer = setTimeout(
    () => reapIfOrphaned(paneId, entry),
    recovery.graceFor(windowOfPane(paneId)),
  )
}

function reapIfOrphaned(paneId: string, entry: PtyEntry): void {
  entry.killTimer = null
  const verdict = orphanVerdict({
    current: ptys.get(paneId) === entry,
    owners: entry.session.ownerCount,
    moving: movingPanes.has(paneId) || entry.keepAlive,
    held: recoveryHeld.has(paneId),
    recovering: recovery.isRecovering(windowOfPane(paneId)),
  })
  if (verdict === 'wait') scheduleReap(paneId, entry)
  else if (verdict === 'reap') killPty(paneId, closedPanes.has(paneId) ? 'closed' : 'grace-expired')
}

function startRecovery(windowId: string, reason: string): void {
  recovery.start(windowId)
  appLog?.info('window-recovering', { window: windowId, reason })
  for (const [paneId, entry] of ptys) {
    if (entry.killTimer && windowOfPane(paneId) === windowId) scheduleReap(paneId, entry)
  }
}

function finishRecovery(windowId: string, livePaneIds: Set<string>): void {
  if (!recovery.end(windowId)) return
  const windowPtys = [...ptys]
    .filter(([paneId, entry]) => !entry.keepAlive && windowOfPane(paneId) === windowId)
    .map(([paneId, entry]) => ({ paneId, owners: entry.session.ownerCount }))
  const { hold, reap } = planRecovery(windowPtys, livePaneIds)
  for (const paneId of hold) {
    const entry = ptys.get(paneId)
    if (entry?.killTimer) clearTimeout(entry.killTimer)
    if (entry) entry.killTimer = null
    recoveryHeld.add(paneId)
  }
  for (const paneId of reap) killPty(paneId, 'closed')
  appLog?.info('window-recovered', { window: windowId, held: hold.length, reaped: reap.length })
}

function releaseWindowPtys(windowId: string): void {
  recovery.end(windowId)
  for (const paneId of [...recoveryHeld]) {
    if (windowOfPane(paneId) !== windowId) continue
    recoveryHeld.delete(paneId)
    const entry = ptys.get(paneId)
    if (entry && entry.session.ownerCount === 0) scheduleReap(paneId, entry)
  }
}

function holdPtys(paneIds: readonly string[]): void {
  for (const paneId of paneIds) {
    const entry = ptys.get(paneId)
    if (!entry) continue
    movingPanes.add(paneId)
    if (entry.killTimer) {
      clearTimeout(entry.killTimer)
      entry.killTimer = null
    }
  }
}

function releaseMovingPane(paneId: string): void {
  if (!movingPanes.delete(paneId)) return
  const entry = ptys.get(paneId)
  if (entry && entry.session.ownerCount === 0) killPty(paneId, 'closed')
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function openExternalSafe(url: string): boolean {
  let scheme: string
  try {
    scheme = new URL(url).protocol
  } catch {
    return false
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) return false
  void shell.openExternal(url)
  return true
}

function keptTmuxDir(): string {
  return join(app.getPath('userData'), KEPT_SHELLS_DIR)
}

function keptShellsName(): string {
  return createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
}

const keptShells = new KeptShells({
  dir: keptTmuxDir(),
  name: keptShellsName(),
  program: keptShellsProgram,
  log: (event, fields) => appLog?.info(event, fields),
})
let tmuxTerminal: string | null = null
let restartRequested = false
let updateRunner: UpdateRunner | null = null
const UPDATE_HOST_GRANT_ID = 'core:update'

function keepShellsOn(): boolean {
  return parseKeepShells(readSettingsFile().terminal?.keepShells)
}

function keptShellsProgram(): KeptProgram | null {
  if (missingRequirements(KEEP_SHELLS_FEATURE).length > 0) return null
  const tmux = programPath('tmux')
  if (!tmux) return null
  return { tmux, defaultTerminal: tmuxDefaultTerminal(), env: process.env }
}

function tmuxDefaultTerminal(): string {
  if (tmuxTerminal === null) {
    try {
      execFileSync('infocmp', ['tmux-256color'], { stdio: 'ignore', timeout: 2000 })
      tmuxTerminal = 'tmux-256color'
    } catch {
      tmuxTerminal = 'screen-256color'
    }
  }
  return tmuxTerminal
}

function savedPaneIds(): Set<string> | null {
  const snapshot = loadSnapshot()
  if (!snapshot) return null
  const ids = new Set<string>()
  const workspaces = [
    ...snapshot.workspaces,
    ...(snapshot.windows ?? []).flatMap((w) => w.workspaces),
  ]
  for (const workspace of workspaces) for (const id of handoffPaneIds(workspace)) ids.add(id)
  return ids
}

function keptProcessOf(paneId: string): KeptProcessMeta | undefined {
  const entry = processes?.forPane(paneId)
  if (!entry || entry.status === 'closed') return undefined
  return {
    name: entry.name,
    cmd: entry.cmd,
    ownerPaneId: entry.ownerPaneId,
    startedAt: entry.startedAt,
    status: entry.status,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
  }
}

function withKeptProcess(meta: KeptMeta): KeptMeta {
  const { process: _old, ...base } = meta
  const current = keptProcessOf(meta.paneId)
  return current ? { ...base, process: current } : base
}

function syncKeptMeta(paneId: string): void {
  const entry = ptys.get(paneId)
  if (!entry?.kept || !entry.keptMeta) return
  entry.keptMeta = withKeptProcess(entry.keptMeta)
  entry.kept.setMeta(entry.keptMeta)
}

function paneLauncherDir(): string {
  return join(app.getPath('userData'), 'bin')
}

function writeKeptLaunchers(): void {
  const dir = paneLauncherDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  replaceFile(
    join(dir, 'ostia-node'),
    `#!/bin/sh\nexec ${quoteArg(process.execPath)} "$@"\n`,
    0o700,
  )
  replaceFile(
    join(dir, 'ostia-cli.js'),
    `require(${JSON.stringify(join(app.getAppPath(), 'out/cli/index.js'))})\n`,
    0o600,
  )
}

let keptPlumbingReady = false

function ensureKeptPlumbing(): void {
  if (keptPlumbingReady) return
  keptPlumbingReady = true
  try {
    writeKeptLaunchers()
  } catch (err) {
    appLog?.warn('launcher-write-failed', {
      launcher: 'kept',
      code: (err as NodeJS.ErrnoException).code ?? null,
    })
  }
  listenKeptControlSocket(keptControlSocketPath(app.getPath('userData')))
}

function keptPaneEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === 'TERM') continue
    out[key] = value
  }
  const launchers = paneLauncherDir()
  return Object.assign(
    out,
    appEnv({
      SOCKET: keptControlSocketPath(app.getPath('userData')),
      CLI: join(launchers, 'ostia-cli.js'),
      NODE: join(launchers, 'ostia-node'),
    }),
  )
}

function killPty(paneId: string, reason: ReapReason): void {
  const entry = ptys.get(paneId)
  if (!entry) return
  appLog?.info('pty-reap', { pane: paneId, reason })
  recoveryHeld.delete(paneId)
  closedPanes.delete(paneId)
  if (entry.killTimer) clearTimeout(entry.killTimer)
  try {
    entry.pty.kill()
  } catch {}
  entry.flow.dispose()
  entry.mirror.dispose()
  removeStateFile(entry)
  keptShells.removeToken(paneId)
  ptys.delete(paneId)
  agentWork.clear(paneId)
}

function hibernatePty(paneId: string): boolean {
  const entry = ptys.get(paneId)
  if (!entry) return false
  telemetry?.count('agents', 'hibernation')
  stashScrollback(paneId, entry.mirror.serialize())
  hibernatedPanes.add(paneId)
  paneWaking.end(paneId, 'failed')
  entry.subs.clear()
  killPty(paneId, 'hibernated')
  terminalState.delete(paneId)
  return true
}

function ptyPid(paneId: string): number | undefined {
  return ptys.get(paneId)?.pty.pid
}

async function paneOutput(paneId: string): Promise<PaneOutput | null> {
  const entry = ptys.get(paneId)
  if (!entry) return null
  const text = await entry.mirror.screenText(HISTORY_LINES)
  const report = entry.mirror.cwdReport
  const remote = report !== null && !isHostNamed(report.host, hostname())
  return { text, cwd: report?.path ?? null, remote }
}

function feedPty(entry: PtyEntry, data: string): void {
  entry.session.push(data)
  entry.mirror.write(data)
  processes?.feed(entry.paneId, data, entry.session.cursor)
}

const paneIo: PaneIo = {
  read: async (paneId, lines) => {
    const entry = ptys.get(paneId)
    return entry ? entry.mirror.screenText(lines) : null
  },
  write: (paneId, data) => {
    const entry = ptys.get(paneId)
    if (!entry) return false
    const pasted = entry.kept ? pastedText(data) : null
    if (entry.kept && pasted !== null) entry.kept.paste(pasted)
    else entry.pty.write(data)
    return true
  },
  bracketedPaste: (paneId) => {
    const entry = ptys.get(paneId)
    if (!entry) return false
    return entry.kept !== null || entry.mirror.bracketedPaste
  },
  outputCursor: (paneId) => ptys.get(paneId)?.session.cursor,
}

function pausePty(entry: PtyEntry, paused: boolean): void {
  try {
    if (paused) entry.pty.pause?.()
    else entry.pty.resume?.()
  } catch {}
}

function releasePtyFlow(subId: string): void {
  for (const entry of ptys.values()) entry.flow.release(subId)
}

function windowShown(wid: string): boolean {
  const win = windows.get(wid)
  return win !== undefined && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
}

function hidePtyFlow(wid: string): void {
  for (const entry of ptys.values()) entry.flow.hidden(wid)
}

function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
}

const scratchFolders = new ScratchFolders(privateTmpDir(`${PRODUCT_NAME}-scratch`))

const artifactFolders = new ArtifactFolders(
  {
    root: join(appDataDir(), 'artifacts'),
    scratchDirOf: (workspaceId) => scratchFolders.dirOf(workspaceId),
    scratchDirs: () => scratchFolders.dirs(),
  },
  (workspaceId, changes) => {
    const windowId = windowForWorkspace(workspaceId)
    if (windowId) windows.get(windowId)?.webContents.send('artifacts:changed', workspaceId)
    for (const { path, change } of changes.slice(0, ARTIFACT_LIST_MAX)) {
      emitPlatformEvent('artifact.changed', { sessionId: workspaceId, path, change })
    }
  },
)

function fileRoots(): string[] {
  return [homedir(), app.getPath('userData'), scratchFolders.root, artifactFolders.root]
}

const openFileGrants = new OpenFileGrants({
  roots: fileRoots,
  file: join(app.getPath('userData'), 'opened-files.json'),
})

const artifactCompiler = new ArtifactCompiler(
  () => loadEsbuild(app.isPackaged),
  `chrome${process.versions.chrome.split('.')[0]}`,
)

const openWaits = new OpenWaits((windowId, paneIds) =>
  windows.get(windowId)?.webContents.send('open-waits:ended', paneIds),
)

const previews = new PreviewHost({
  sessionOf: (partition) => session.fromPartition(partition) as unknown as PreviewSession,
  confine: (path) => openFileGrants.confine(path),
  servesFolder: (dir) => artifactFolders.holds(dir),
  ownsPane: (windowId, paneId) => getByPaneId(paneId)?.windowId === windowId,
  send: (windowId, event) => windows.get(windowId)?.webContents.send('preview:event', event),
  processes: () =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      memoryBytes: metric.memory.workingSetSize * 1024,
      cpuPercent: metric.cpu.percentCPUUsage,
    })),
  runtimeDir: () =>
    app.isPackaged
      ? join(process.resourcesPath, 'artifact-runtime')
      : join(app.getAppPath(), 'out', 'artifact-runtime'),
  compile: (file, source) => artifactCompiler.compile(file, source),
})

function isScratchPane(paneId: string): boolean {
  return scratchFolders.isScratch(getByPaneId(paneId)?.workspaceId)
}

const workspaceSandboxes: WorkspaceSandboxes = new WorkspaceSandboxes({
  store: new SandboxStore(join(app.getPath('userData'), 'sandbox.json')),
  globals: () => parseSandboxGlobals((readSettingsFile() as { sandbox?: unknown }).sandbox),
  basePaths: () => {
    const base: SandboxBasePaths = {
      home: homedir(),
      dataDirs: [
        app.getPath('userData'),
        dirname(storePath('workspaces', 'global')),
        ...[
          join(app.getPath('appData'), OLD_PRODUCT_NAME),
          join(configHome(), OLD_PRODUCT_NAME),
          join(dataHome(), OLD_PRODUCT_NAME),
        ].filter((dir) => existsSync(dir)),
      ],
      runtimeDir: process.env.XDG_RUNTIME_DIR,
      agentSockets: process.env.SSH_AUTH_SOCK ? [process.env.SSH_AUTH_SOCK] : [],
      containerSockets: reachableContainerSockets(),
      socketPath: controlSocketPath(),
      srtVendorDir: srtVendorDir(app.getAppPath()),
      runtimeReads: [
        INTEGRATION_DIR,
        privateTmpDir(`${PRODUCT_NAME}-shell-state`),
        app.getAppPath(),
        dirname(process.execPath),
        paneLauncherDir(),
      ],
    }
    return keepShellsOn()
      ? { ...base, keptSocketPath: keptControlSocketPath(app.getPath('userData')) }
      : base
  },
  workDir: (workspaceId) => workDirForWorkspace(workspaceId),
  tmpRoot: privateTmpDir(`${PRODUCT_NAME}-sbx`),
  nodePath: process.execPath,
  hostScript: join(app.getAppPath(), 'out/sandbox/host.mjs'),
  onAsk: (workspaceId, host, port) =>
    domainRequests.onBlocked(workspaceSandboxes.owner(workspaceId), host, port),
  onPackageBlocked: (workspaceId, pkg, reason) =>
    packageRequests.blocked(workspaceSandboxes.owner(workspaceId), pkg, reason),
  onViolations: (workspaceId, lines) =>
    recordViolations(
      sandboxViolations,
      (path) => workspaceSandboxes.writeRefusal(workspaceId, path),
      workspaceSandboxes.owner(workspaceId),
      lines,
    ),
  kept: {
    enabled: () => keepShellsOn() && keptShellsProgram() !== null,
    tmpRoot: join(privateTmpDir(`${PRODUCT_NAME}-sbx`), `kept-${keptShellsName()}`),
    channel: (workspaceId) =>
      join(
        keptTmuxDir(),
        `host-${createHash('sha256').update(`${keptShellsName()}\0${workspaceId}`).digest('hex').slice(0, 16)}.sock`,
      ),
    claim: (workspaceId) => {
      const claimed = keptShells.claimHost(workspaceId)
      if (!claimed) return undefined
      keptHostPanes.set(workspaceId, claimed)
      return { channel: claimed.meta.channel, tmpDir: claimed.meta.tmpDir }
    },
    spawn: async (workspaceId, spec) => {
      const meta: KeptHostMeta = {
        kind: SANDBOX_HOST_KIND,
        workspaceId,
        channel: spec.channel,
        tmpDir: spec.tmpDir,
        protocol: HOST_PROTOCOL_VERSION,
        exposed: [],
      }
      const pane = await keptShells.spawnHost({
        file: spec.file,
        args: spec.args,
        cwd: spec.tmpDir,
        env: spec.env,
        meta,
      })
      keptHostPanes.set(workspaceId, { pane, meta })
    },
    stop: (workspaceId) => {
      keptHostPanes.get(workspaceId)?.pane.kill()
      keptHostPanes.delete(workspaceId)
    },
  },
})

const keptHostPanes = new Map<string, { pane: TmuxPane; meta: KeptHostMeta }>()

function syncKeptExposed(workspaceId: string, listening?: readonly SandboxListener[]): void {
  const host = keptHostPanes.get(workspaceId)
  if (!host) return
  const exposed = portRequests.exposures(workspaceId, listening)
  if (JSON.stringify(exposed) === JSON.stringify(host.meta.exposed)) return
  host.meta = { ...host.meta, exposed }
  host.pane.setMeta(host.meta)
}

const sandboxViolations = new ViolationLog()

let languageServers: LanguageServers | null = null

function editorLanguageOf(path: string): string {
  return languageForPath(
    path,
    (extensionHost?.editorLanguages() ?? []).map((source) => source.language),
  )
}

const managedServers = new ManagedServers({
  dir: join(app.getPath('userData'), 'language-servers'),
  userAgent: releaseUserAgent(app.getVersion()),
  findProgram: (program) => programPath(program),
  env: () => scrubbedEnv(process.env),
  baseUrl: downloadBaseUrl(app.isPackaged, process.env),
})

function sandboxCanRead(workspaceId: string, path: string): boolean {
  try {
    const { denyRead, allowRead } = workspaceSandboxes.config(workspaceId).filesystem
    return visibleInSandbox(path, { denyRead, allowRead })
  } catch {
    return false
  }
}

function phoneReadRules(workspaceId: string): SandboxReadRules {
  if (!workspaceSandboxes.isEnabled(workspaceId)) return { denyRead: [], allowRead: [] }
  try {
    const { denyRead, allowRead } = workspaceSandboxes.config(workspaceId).filesystem
    return { denyRead, allowRead }
  } catch {
    return { denyRead: ['/'], allowRead: [] }
  }
}

function phoneFileScope(workspaceId: string): PhoneFileScope {
  const { home, dataDirs } = workspaceSandboxes.pathEnv()
  return { home, dataDirs, rules: phoneReadRules(workspaceId) }
}

const LANGUAGE_SERVER_WATCH_DEBOUNCE_MS = 300
const languageServerWatches = new TreeWatches({
  confine: (dir) => resolveSafe(dir, fileRoots()),
  debounceMs: LANGUAGE_SERVER_WATCH_DEBOUNCE_MS,
})

const serverOverrides = new ServerOverrides(
  join(app.getPath('userData'), 'language-server-programs.json'),
)

function createLanguageServers(): LanguageServers {
  return new LanguageServers({
    watchTree: (root, onChange) => languageServerWatches.watch(root, onChange),
    sources: () =>
      (extensionHost?.languageServers() ?? []).map((source) => {
        const override = serverOverrides.get(languageServerKey(source.extId, source.server.id))
        return override ? { ...source, override } : source
      }),
    nodePath: process.execPath,
    env: () => process.env,
    pane: (paneId) => getByPaneId(paneId),
    confine: (path) => openFileGrants.confine(path),
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    roots: fileRoots,
    sandbox: {
      owner: (workspaceId) =>
        workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
          ? workspaceSandboxes.owner(workspaceId)
          : null,
      readable: sandboxCanRead,
      wrap: (workspaceId, command, extraReads) =>
        workspaceSandboxes.wrap(workspaceId, command, 'bash', [], extraReads),
      env: (workspaceId, env) => ({
        ...sandboxSpawnEnv(env as Record<string, string>),
        TMPDIR: workspaceSandboxes.tmpDir(workspaceId),
      }),
    },
    findProgram: (program) => programPath(program),
    languageOf: editorLanguageOf,
    managed: managedServers,
    registerRequirements,
    post: (windowId, channel, ...args) => {
      const win = windows.get(windowId)
      if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
    },
    changed: (list) => broadcast('lsp:servers-changed', list),
    log: (event, fields) => appLog?.info(event, fields),
  })
}

function paneForWorkspace(workspaceId: string): string | undefined {
  for (const [paneId, entry] of ptys) {
    if (entry.workspaceId === workspaceId && entry.sandboxed) return paneId
  }
  return undefined
}

const domainRequests: DomainRequests = new DomainRequests({
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  blockedDomains: (workspaceId) => workspaceSandboxes.resolved(workspaceId).deniedDomains,
  ask: async ({ workspaceId, paneId, host, origin }) => {
    const pane = paneId ? getByPaneId(paneId) : undefined
    const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'sandbox-domain',
      subject: host,
      action: origin === 'agent' ? `ostia sandbox request-domain ${host}` : `connect to ${host}`,
      detail: '',
    })
  },
  allowWorkspace: (workspaceId, domain) => {
    workspaceSandboxes.update(workspaceId, (current) => ({
      ...current,
      domains: current.domains.includes(domain) ? current.domains : [...current.domains, domain],
    }))
  },
  allowUntilRestart: (workspaceId, domain) =>
    workspaceSandboxes.allowUntilRestart(workspaceId, domain),
  now: Date.now,
})

let onSandboxSpawnFailure: ((workspaceId: string, errors: string[]) => void) | null = null

function sandboxedPanes(workspaceId: string): SandboxPane[] {
  const panes: SandboxPane[] = []
  for (const entry of ptys.values()) {
    if (entry.workspaceId === workspaceId && entry.sandboxed) {
      panes.push({ pid: entry.pty.pid, bridge: entry.portBridge })
    }
  }
  return panes
}

const portForwarder = new PortForwarder({
  onChange: (workspaceId) => syncKeptExposed(workspaceId),
  panesOf: sandboxedPanes,
  unixSocketsOff: (workspaceId) => !workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
})

const PACKAGE_BATCH_MS = 600

const packageRequests: PackageRequests = new PackageRequests({
  batchMs: PACKAGE_BATCH_MS,
  ask: async ({ workspaceId, kind, packages }) => {
    const identity = getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    const names = packages.map((p) => `${p.ref.name}@${p.ref.version}`)
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind,
      subject: names.join(', '),
      action: `install ${names.length} package${names.length === 1 ? '' : 's'}`,
      detail: packages
        .map((p) => `${p.ref.ecosystem} ${p.ref.name}@${p.ref.version}: ${p.reason}`)
        .join('\n'),
    })
  },
  allowWorkspace: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, true),
  allowUntilRestart: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, false),
})

const portRequests: PortRequests = new PortRequests({
  platform: process.platform,
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  policy: (workspaceId) => workspaceSandboxes.resolved(workspaceId).portsPolicy,
  ask: async ({ workspaceId, paneId, port, process: owner, origin }) => {
    const pane = paneId ? getByPaneId(paneId) : undefined
    const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'sandbox-port',
      subject: String(port),
      action:
        origin === 'agent' ? `ostia sandbox expose ${port}` : `a server started on port ${port}`,
      detail: owner ?? '',
    })
  },
  forwarder: portForwarder,
})

const PORT_SCAN_MS = 3000

const HOST_GRANT_TTL_MS = 120_000
const hostPaneGrants = new HostPaneGrants({ now: Date.now, ttlMs: HOST_GRANT_TTL_MS })

function scanSandboxPorts(): void {
  const workspaces = new Set<string>()
  for (const entry of ptys.values()) if (entry.sandboxed) workspaces.add(entry.workspaceId)
  for (const workspaceId of workspaces) {
    void portRequests.scan(workspaceId).then(() => syncKeptExposed(workspaceId))
  }
}

const GH_TOKEN_TTL_MS = 60_000
let ghTokenCache: { at: number; value: string | null } | null = null

function ghToken(): string | null {
  if (ghTokenCache && Date.now() - ghTokenCache.at < GH_TOKEN_TTL_MS) return ghTokenCache.value
  let value: string | null = null
  if (onPath('gh')) {
    try {
      value =
        execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 3000 }).trim() || null
    } catch {
      value = null
    }
  }
  ghTokenCache = { at: Date.now(), value }
  return value
}

const secretService: SecretService = new SecretService({
  home: homedir,
  env: () => process.env,
  ghToken,
  vault: {
    list: (workspaceId) => [
      ...vaultKeys('global', workspaceId).map((key) => ({ key, scope: 'global' as const })),
      ...vaultKeys('project', workspaceId).map((key) => ({ key, scope: 'project' as const })),
    ],
    get: (key, scope, workspaceId) => vaultValue(key, scope, workspaceId),
  },
  grantedIds: (workspaceId) =>
    (workspaceSandboxes.settings(workspaceId).secrets ?? []).map((g) => g.id),
  ask: async ({ workspaceId, paneId, name, reason }) => {
    const identity = getByPaneId(paneId) ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
    const queue = approvals()
    if (!identity || !queue) return 'deny'
    return queue.request({
      externalId: identity.externalId,
      windowId: identity.windowId,
      paneId: identity.paneId,
      workspaceId,
      caps: [],
      kind: 'secret',
      subject: name,
      action: `ostia secret get ${name}`,
      detail: reason,
    })
  },
})

const workspaceAgents = new WorkspaceAgents()

async function injectSecrets(
  workspaceId: string,
): Promise<{ env: Record<string, string>; notice: string }> {
  const grants = workspaceSandboxes.settings(workspaceId).secrets ?? []
  if (grants.length === 0) return { env: {}, notice: '' }
  const dir = join(workspaceSandboxes.tmpDir(workspaceId), 'secrets')
  const prepared = prepareSecrets({
    grants,
    list: secretService.list(workspaceId),
    value: (id) => secretService.value(workspaceId, id),
    dir,
  })
  const env = { ...prepared.env }
  try {
    const socket = await workspaceAgents.ensure(
      workspaceId,
      workspaceSandboxes.sshAgentSocket(workspaceId),
      prepared.sshKeys,
    )
    if (socket) env.SSH_AUTH_SOCK = socket
  } catch {
    prepared.missing.push('ssh-agent')
  }
  const notice =
    prepared.missing.length > 0
      ? `\x1b[33m Granted secrets not found: ${prepared.missing.join(', ')}\x1b[0m\r\n`
      : ''
  return { env, notice }
}

const browserProfiles = new BrowserProfiles({
  ownerOf: (paneId) => {
    const identity = getByPaneId(paneId)
    return identity ? { windowId: identity.windowId, workspaceId: identity.workspaceId } : null
  },
  isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
  isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
})

const browserFence = new BrowserFence({
  policy: (workspaceId) => {
    if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return null
    const resolved = workspaceSandboxes.resolved(workspaceId)
    return {
      browser: resolved.controls.browser,
      domains: resolved.domains,
      denied: resolved.deniedDomains,
    }
  },
  requestDomain: async (workspaceId, host) =>
    (await domainRequests.request(workspaceId, '', host)).ok,
})

setCapFilter((conn, cap) => {
  if (cap !== 'all-workspaces') return true
  const workspaceId = resolveExternal(conn.externalId)?.workspaceId || conn.workspaceId
  if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return true
  return workspaceSandboxes.resolved(workspaceId).controls.allWorkspaces
})

async function workspaceListing(): Promise<ReachListing> {
  const [workspaces, groups] = await Promise.all([
    listWorkspaces({ execCommand, windowIds }),
    listWorkspaceGroups({ execCommand, windowIds }),
  ])
  return { workspaces, groups }
}

const reach = createReach({
  mode: loadReachMode,
  home: homedir(),
  workDir: (workspaceId) => workDirForWorkspace(workspaceId),
  isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
  hasManager: (workspaceId) => workspaceHasManager(workspaceId),
  sandbox: (workspaceId) => ({
    ...workspaceSandboxes.settings(workspaceId),
    enabled: workspaceSandboxes.isEnabled(workspaceId),
  }),
  workspaces: workspaceListing,
  ask: (ask) => approvals()?.request(ask) ?? null,
  agentGroupsChanged: (placements) => broadcast('reach:agent-groups-changed', placements),
  scriptScope: (tokenId) => scriptTokenScope(scriptTokensPath(), tokenId),
  scriptCreated: (tokenId, workspaceId) =>
    recordCreatedWorkspace(scriptTokensPath(), tokenId, workspaceId),
})
ipcMain.handle('reach:agent-groups', () => reach.agentGroups())

function workspaceOfGuest(guest: Electron.WebContents): string | undefined {
  for (const [paneId, wcId] of browserPanes) {
    if (wcId === guest.id) return getByPaneId(paneId)?.workspaceId
  }
  return undefined
}

function fenceBrowserGuest(guest: Electron.WebContents): void {
  const guard = (e: Electron.Event, url: string): void => {
    const workspaceId = workspaceOfGuest(guest)
    if (!workspaceId || browserFence.allowedNow(workspaceId, url)) return
    e.preventDefault()
    void browserFence.check(workspaceId, url).then((ok) => {
      if (ok && !guest.isDestroyed()) void guest.loadURL(url).catch(() => {})
    })
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)
}

const windows = new Map<string, BrowserWindow>()
const commandsByWindow = new Map<string, CommandDescriptor[]>()

const browserPanes = new Map<string, number>()

const consoleBuffers = new Map<number, ConsoleEntry[]>()
const errorBuffers = new Map<number, ConsoleEntry[]>()

const terminalState = new Map<string, TerminalStateSnapshot>()

let extensionHost: ExtensionHost | null = null
let gitService: GitService | null = null
let portsService: PortsService | null = null

function emitPaneEvent<T extends ExtensionEventType>(
  type: T,
  payload: ExtensionEventPayloads[T],
): void {
  extensionHost?.emitEvent(type, payload)
  gitService?.activity(type)
  portsService?.activity(type)
}

function refreshAgentPlugins(): void {
  try {
    setAgentPlugins(
      agentPluginContent(extensionHost?.agentPlugins() ?? [], (extId, problem) =>
        console.error(`[ext:${extId}] ${problem}`),
      ),
    )
  } catch (err) {
    console.error(`agent plugins: ${(err as Error).message}`)
  }
}
let viewHost: ViewHost | null = null
let mcpHost: McpHost | null = null
let mcpOAuth: McpOAuth | null = null
let broker: WindowBroker | null = null
const agentRunning = new AgentRunningPanes(() => broker?.persist())
const agentWork = new ReportedAgentWork()

const askHub = createAskHub({
  questions,
  approvals,
  identity: getByPaneId,
  created: (ask) => emitPlatformEvent('ask.created', { ask }),
  resolved: (resolved) => emitPlatformEvent('ask.resolved', resolved),
})
const keptAttention = new KeptAttention()

function restoreKeptAttention(identity: PaneIdentity, saved: SavedAttention): void {
  void execCommand(targetOf(identity), 'attention.set', saved).then((res) => {
    if (res.ok) keptAttention.reported(identity.paneId)
  })
}
const paneWatch = new PaneWatch()
const paneWaking = new PaneWaking()
const isWaking = (paneId: string): boolean => paneWaking.has(paneId)
const reachesPane: OriginReach = (senderWindowId, sourcePaneId, targetPaneId) =>
  broker?.reaches(senderWindowId, sourcePaneId, targetPaneId) ?? false
let profileSync: ProfileSyncHandle | null = null

const EXTENSION_PARTITION_PREFIX = 'ostia-ext-'

function configDir(): string {
  return appConfigDir()
}

function extensionRoots(): ExtensionRoot[] {
  const builtinDir = app.isPackaged
    ? join(process.resourcesPath, 'extensions')
    : join(app.getAppPath(), 'out/extensions')
  return [
    { dir: builtinDir, builtin: true },
    { dir: join(configDir(), 'extensions'), builtin: false },
  ]
}

let stopTailnet: (() => Promise<void>) | null = null
let stopAnnouncing: (() => void) | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function extensionOfPartition(partition: string | undefined): string | null {
  if (!partition?.startsWith(EXTENSION_PARTITION_PREFIX)) return null
  return partition.slice(EXTENSION_PARTITION_PREFIX.length)
}

const instrumentedGuests = new WeakSet<Electron.WebContents>()
let clipboardEdits: ClipboardEdits | null = null
let guestChords: GuestChords | null = null

function instrumentBrowserGuest(gc: Electron.WebContents): void {
  const wcId = gc.id
  if (!instrumentedGuests.has(gc)) {
    instrumentedGuests.add(gc)
    gc.on('console-message', (event) => {
      const entry: ConsoleEntry = {
        level: event.level,
        text: event.message,
        ts: Date.now(),
      }
      pushConsoleEntry(consoleBuffers, wcId, entry)
      if (entry.level === 'error' || event.message.startsWith(OSTIA_ERROR_PREFIX)) {
        pushConsoleEntry(errorBuffers, wcId, entry)
      }
    })
  }
  if (!gc.debugger.isAttached()) {
    try {
      gc.debugger.attach('1.3')
      gc.debugger
        .sendCommand('Page.enable')
        .then(() =>
          gc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
            source: PAGE_ERROR_CATCHER_JS,
          }),
        )
        .catch(() => {})
    } catch {}
  }
  watchGuestNetwork(gc)
}

function hardenExtensionGuest(guest: Electron.WebContents): boolean {
  const host = extensionHost
  if (!host) return false
  const extId = host
    .panelExtensionIds()
    .find((id) => guest.session === session.fromPartition(`${EXTENSION_PARTITION_PREFIX}${id}`))
  if (!extId) return false
  guest.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  guest.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  const guard = (e: Electron.Event, url: string): void => {
    if (!host.isAllowedPanelUrl(extId, url)) e.preventDefault()
  }
  guest.on('will-navigate', guard)
  guest.on('will-redirect', guard)
  return true
}

function frameOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
  }
  return { frame: false }
}

function baseWebPreferences(): Electron.WebPreferences {
  return {
    preload: join(app.getAppPath(), 'out/preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: true,
  }
}

let quitApproved = false
let quitAsking = false
let quitRequested = false

function requestQuit(): void {
  quitRequested = true
  app.quit()
}
let quitSignaled = false

function handleQuitSignals(): void {
  for (const signal of QUIT_SIGNALS) {
    process.on(signal, () => {
      appLog?.info('quit-signal', { signal })
      quitSignaled = true
      app.quit()
    })
  }
}
const startedHidden = app.commandLine.hasSwitch('hidden')
let appTray: AppTray | null = null
let globalHotkey: GlobalHotkey | null = null
let releaseChecks: { settingsChanged: () => void } | null = null
let managerService: ManagerService | null = null
let managerLimiter: ManagerLimiter | null = null
let portal: Portal | null = null

function wireWindow(win: BrowserWindow): void {
  win.once('ready-to-show', () => {
    if (startedHidden && appTray) appTray.hide(win)
    else win.show()
  })

  win.on('close', (event) => {
    if (quitApproved || broker?.isReturning(win)) return
    const action = closeAction({
      quitApproved,
      closeToTray: readCloseToTray(readSettingsFile()),
      startedHidden,
      managerLive: managerService?.live != null,
    })
    if (action === 'hide' && appTray && !broker?.isDetached(win)) {
      event.preventDefault()
      appTray.hide(win)
      return
    }
    event.preventDefault()
    if (broker?.isDetached(win)) broker.requestReturn(win, true)
    else requestQuit()
  })

  const emitMaximized = (): void => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', emitMaximized)
  win.on('unmaximize', emitMaximized)

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })

  attachContextMenu(win.webContents, false)

  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (isPreviewPartition(params.partition)) {
      if (previews.acceptsAttach(params.partition, params.src, String(win.webContents.id))) {
        hardenPreviewAttach(webPreferences, params)
      } else {
        event.preventDefault()
      }
      return
    }
    const extId = extensionOfPartition(params.partition)
    const allowed = extId
      ? (extensionHost?.isAllowedPanelUrl(extId, params.src) ?? false)
      : browserProfiles.acceptsAttach(params.partition, String(win.webContents.id))
    if (!allowed) {
      event.preventDefault()
      return
    }
    webPreferences.preload = undefined
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    clipboardEdits?.guardGuest(guest)
    guestChords?.guardGuest(guest)
    if (previews.adopt(guest)) return
    if (hardenExtensionGuest(guest)) {
      attachContextMenu(guest, false)
      return
    }
    attachContextMenu(guest, true)
    const agent = browserUserAgent(guest.session.getUserAgent(), app.getName())
    guest.session.setUserAgent(agent)
    guest.setUserAgent(agent)
    instrumentBrowserGuest(guest)
    fenceBrowserGuest(guest)
    const wcId = guest.id
    guest.once('destroyed', () => {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      forgetGuestNetwork(wcId)
    })
  })

  const wid = String(win.webContents.id)
  windows.set(wid, win)
  diagnostics?.watchWindow(win)
  win.on('hide', () => hidePtyFlow(wid))
  win.on('minimize', () => hidePtyFlow(wid))
  win.on('closed', () => {
    windows.delete(wid)
    gitService?.windowGone(wid)
    portsService?.windowGone(wid)
    releaseWindowPtys(wid)
    previews.windowClosed(wid)
    openWaits.windowGone(wid)
    fileWatches?.unwatchOwner(wid)
    commandsByWindow.delete(wid)
    for (const [paneId, wcId] of browserPanes) {
      if (getByPaneId(paneId)?.windowId === wid) {
        browserPanes.delete(paneId)
        consoleBuffers.delete(wcId)
        errorBuffers.delete(wcId)
        clearGuestBrowseState(wcId)
        forgetGuestNetwork(wcId)
      }
    }
    removeWindow(wid)
    for (const entry of ptys.values()) {
      if (entry.subs.has(wid)) {
        entry.subs.delete(wid)
        entry.session.removeSubscriber(wid)
      }
    }
  })
}

function initialBackground(): string {
  const follow = (readSettingsFile() as { appearance?: { followSystem?: unknown } }).appearance
    ?.followSystem
  return follow !== false && !nativeTheme.shouldUseDarkColors ? '#fbfcfd' : '#1d2022'
}

function createWindow(slot: string, bounds?: WindowBounds): BrowserWindow {
  const win = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 800 }),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: initialBackground(),
    show: false,
    autoHideMenuBar: true,
    title: PRODUCT_DISPLAY_NAME,
    icon: appIcon,
    ...frameOptions(),
    webPreferences: baseWebPreferences(),
  })

  wireWindow(win)
  broker?.track(win, slot)

  if (devServerUrl) {
    win.loadURL(devServerUrl)
    if (slot === MAIN_SLOT) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(join(app.getAppPath(), 'out/renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => 'pong' as const)
  ipcMain.handle('settings:path', () => join(app.getPath('userData'), 'settings.json'))
  ipcMain.handle('editor:open-external', (_e, req: ExternalEditorRequest) =>
    openInExternalEditor(req),
  )
  ipcMain.handle(
    'app:info',
    (): AppInfo => ({
      name: PRODUCT_DISPLAY_NAME,
      version: appVersion(),
      platform: process.platform,
      hostName: hostname(),
      home: app.getPath('home'),
      desktops: process.platform === 'linux' ? desktopsOf(process.env.XDG_CURRENT_DESKTOP) : [],
    }),
  )

  registerCloseGuard()
  ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.on('window:quit', () => requestQuit())
  ipcMain.handle('window:system-dark', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('window:system-dark-changed', nativeTheme.shouldUseDarkColors)
      }
    }
  })
  ipcMain.on('window:beep', () => shell.beep())
  ipcMain.on('window:write-primary', (_e, text: unknown) => {
    if (acceptsPrimarySelection(process.platform, text)) {
      clipboard.selection?.writeText(text).catch(() => undefined)
    }
  })
  ipcMain.handle('window:set-zoom', (e, percent: unknown) => {
    const clamped = clampZoom(percent)
    e.sender.setZoomFactor(zoomFactor(clamped))
    return clamped
  })
  ipcMain.handle(
    'window:is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  )

  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    const owner = 'paneId' in event ? getByPaneId(event.paneId)?.windowId : undefined
    if (owner && owner !== windowId && windows.has(owner)) return
    if (event.type === 'pane-created') {
      const identity = registerPane({
        windowId,
        workspaceId: event.workspaceId,
        paneId: event.paneId,
      })
      emitPaneEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: event.workspaceId,
      })
    } else if (event.type === 'pane-closed') {
      previews.paneClosed(event.paneId)
      openWaits.paneClosed(event.paneId)
      const identity = getByPaneId(event.paneId)
      if (identity) {
        dropIdentity(identity.externalId)
        approvals()?.forget(identity.externalId)
        questions()?.forget(identity.externalId)
        updateRunner?.paneClosed(identity.externalId)
        emitPaneEvent('pane.closed', {
          paneId: identity.externalId,
          workspaceId: event.workspaceId,
        })
      }
      extensionHost?.clearPaneChips(event.paneId)
      releaseMovingPane(event.paneId)
      if (managerService?.isManagerPane(event.paneId)) killPty(event.paneId, 'closed')
      if (ptys.has(event.paneId)) closedPanes.add(event.paneId)
      dropRestoredScrollback(event.paneId)
      hibernatedPanes.delete(event.paneId)
      browserProfiles.forget(event.paneId)
      removePane(event.paneId)
      terminalState.delete(event.paneId)
      processes?.paneClosed(event.paneId)
      paneWaking.end(event.paneId, 'closed')
      paneWatch.emit(event.paneId, { kind: 'closed' })
    } else if (event.type === 'workspace-added') {
      setWorkspaceWorkDir(event.workspaceId, event.workDir, windowId)
      scratchFolders.bind(event.workspaceId, event.workDir, windowId)
      extensionHost?.publishWorkspaceChips()
      extensionHost?.remoteFolders?.ownerChanged(event.workspaceId)
    } else if (event.type === 'workspace-closed') {
      removeWorkspace(event.workspaceId)
      reach.forget(event.workspaceId)
      processes?.workspaceClosed(event.workspaceId)
      extensionHost?.clearWorkspaceChips(event.workspaceId)
      extensionHost?.remoteFolders?.workspaceClosed(event.workspaceId)
      openWaits.workspaceClosed(event.workspaceId)
      artifactFolders.close(event.workspaceId)
      scratchFolders.remove(event.workspaceId)
      forgetWorkspaceRequests(event.workspaceId)
      forgetSandboxRuntime(event.workspaceId)
    } else if (event.type === 'workspace-activated') {
    } else if (event.type === 'workspace-state') {
      emitSessionState(event.workspaceId, event.state)
    } else if (event.type === 'pane-attention') {
      paneWatch.attention(event.paneId, event.state, event.message)
      if (ptys.get(event.paneId)?.kept) {
        keptShells.saveAttention(
          event.paneId,
          isKeptAttentionState(event.state)
            ? { state: event.state, ...(event.message ? { message: event.message } : {}) }
            : null,
        )
      }
    }
  })

  ipcMain.on('commands:register', (e, descriptors: CommandDescriptor[]) => {
    commandsByWindow.set(String(e.sender.id), descriptors)
  })

  ipcMain.on('terminal:state', (_e, snapshot: TerminalStateSnapshot) => {
    const cur = terminalState.get(snapshot.paneId)
    if (!cur || snapshot.generation >= cur.generation) {
      const changed =
        !cur ||
        cur.cwd !== snapshot.cwd ||
        cur.running !== snapshot.running ||
        cur.blockCount !== snapshot.blockCount ||
        cur.lastExitCode !== snapshot.lastExitCode
      terminalState.set(snapshot.paneId, snapshot)
      if (cur?.running && !snapshot.running) paneWaking.end(snapshot.paneId, 'failed')
      if (changed) {
        paneWatch.emit(snapshot.paneId, { kind: 'state' })
        const identity = getByPaneId(snapshot.paneId)
        if (identity) {
          updateRunner?.paneState(identity.externalId, snapshot.running, snapshot.lastExitCode)
          emitTerminalExtensionEvents(identity.externalId, identity.workspaceId, cur, snapshot)
          emitPlatformEvent('pane.state', {
            paneId: identity.externalId,
            generation: snapshot.generation,
            cwd: snapshot.cwd,
            running: snapshot.running,
            blockCount: snapshot.blockCount,
            lastExitCode: snapshot.lastExitCode,
          })
        }
      }
    }
  })

  ipcMain.handle('browser:claim-profile', (e, paneId: unknown, profile: unknown) =>
    browserProfiles.claim(paneId, String(e.sender.id), profile),
  )
  ipcMain.on('browser:register', (e, paneId: string, webContentsId: number) => {
    const wid = String(e.sender.id)
    if (getByPaneId(paneId)?.windowId !== wid) return
    const gc = webContents.fromId(webContentsId)
    if (!gc || gc.getType() !== 'webview' || gc.hostWebContents?.id !== e.sender.id) return
    const expected = browserPartition(browserProfiles.profileOf(paneId), paneId)
    if (gc.session !== session.fromPartition(expected)) return
    browserPanes.set(paneId, webContentsId)
    instrumentBrowserGuest(gc)
  })
  ipcMain.on('browser:unregister', (e, paneId: string) => {
    const owner = getByPaneId(paneId)?.windowId
    if (owner && owner !== String(e.sender.id)) return
    cancelPick(paneId)
    const wcId = browserPanes.get(paneId)
    browserPanes.delete(paneId)
    if (wcId !== undefined) {
      consoleBuffers.delete(wcId)
      errorBuffers.delete(wcId)
      clearGuestBrowseState(wcId)
      clearGuestNetwork(wcId)
    }
  })
}

function emitTerminalExtensionEvents(
  paneId: string,
  workspaceId: string,
  prev: TerminalStateSnapshot | undefined,
  next: TerminalStateSnapshot,
): void {
  if (next.cwd && prev?.cwd !== next.cwd) {
    emitPaneEvent('cwd.changed', { paneId, workspaceId, cwd: next.cwd })
  }
  if (next.running && !prev?.running) {
    emitPaneEvent('command.started', { paneId, workspaceId, cwd: next.cwd })
  } else if (!next.running && prev?.running) {
    emitPaneEvent('command.finished', {
      paneId,
      workspaceId,
      cwd: next.cwd,
      exitCode: next.lastExitCode,
    })
  }
}

function registerExtensionIpc(host: ExtensionHost): void {
  ipcMain.handle('extensions:list', () => host.list())
  ipcMain.handle('extensions:set-enabled', (_e, extId: string, enabled: boolean) =>
    host.setEnabled(String(extId), enabled === true),
  )
  ipcMain.handle('extensions:approve', (_e, extId: string) => host.approve(String(extId)))
  ipcMain.handle('extensions:sidebar', () => host.sidebarItems())
  ipcMain.handle('extensions:chips', () => host.paneChips())
  ipcMain.handle('extensions:workspace-chips', (e) =>
    workspaceChipsForWindow(host.workspaceChips(), workspaceWindowId, String(e.sender.id)),
  )
  ipcMain.handle('extensions:set-setting', (_e, extId: unknown, key: unknown, value: unknown) => {
    if (typeof extId === 'string' && marketplaceInstallIds().includes(extId)) {
      telemetry?.count('extensions', 'setting_change', `${extId}.${String(key)}`)
    }
    return host.setSetting(String(extId), String(key), value)
  })
  ipcMain.handle('extensions:set-secret', (_e, extId: unknown, key: unknown, value: unknown) =>
    host.setSecret(String(extId), String(key), value),
  )
  ipcMain.handle(
    'extensions:invoke',
    (
      _e,
      extId: string,
      command: string,
      target: { workspaceId: string | null; paneId: string | null },
      argument?: unknown,
    ): Promise<ExtensionResult> => {
      const paneId = target?.paneId ? getByPaneId(target.paneId)?.externalId : undefined
      const cwd = target?.paneId ? terminalState.get(target.paneId)?.cwd : undefined
      const remote = target?.paneId ? remoteCwdOfPane(target.paneId) : undefined
      const caller = host.userCaller(target?.workspaceId ?? null, {
        capabilities: host.commandCapabilities(extId, command),
        ...(paneId ? { paneId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(remote ? { remote } : {}),
      })
      return host.invoke(extId, command, host.paletteArgs(extId, command, argument), caller)
    },
  )
  ipcMain.handle('extensions:panel', (_e, extId: string, context: ExtensionPanelContext) =>
    host.resolvePanel(String(extId), {
      workspaceId: String(context?.workspaceId ?? ''),
      locale: String(context?.locale ?? 'en'),
      ...(context?.path === undefined ? {} : { path: String(context.path) }),
    }),
  )
}

function remoteCwdOfPane(paneId: string): RemoteCwd | undefined {
  return normalizeRemoteCwd(terminalState.get(paneId)?.remote) ?? undefined
}

function publishRemoteFolders(folders: RemoteFolders): void {
  for (const [windowId, win] of windows) {
    if (win.isDestroyed()) continue
    win.webContents.send('remote-files:folders-changed', folders.forWindow(windowId))
  }
}

function registerRemoteFilesIpc(host: ExtensionHost): void {
  const folders = host.remoteFolders
  if (!folders) return
  registerRemoteFolderConfirm()
  const sender = (e: Electron.IpcMainInvokeEvent): string => String(e.sender.id)
  ipcMain.handle('remote-files:folders', (e) => folders.forWindow(sender(e)))
  ipcMain.handle('remote-files:close', (e, folderId: unknown) =>
    folders.closeByWindow(sender(e), folderId),
  )
  ipcMain.handle('remote-files:list', (e, path: unknown) => folders.list(sender(e), path))
  ipcMain.handle('remote-files:stat', (e, path: unknown) => folders.stat(sender(e), path))
  ipcMain.handle('remote-files:read', (e, path: unknown) => folders.read(sender(e), path))
  ipcMain.handle('remote-files:write', (e, path: unknown, content: unknown, baseVersion: unknown) =>
    folders.write(sender(e), path, content, baseVersion),
  )
}

function registerMarketplaceIpc(marketplace: Marketplace): void {
  ipcMain.handle('marketplace:list', () => marketplace.state())
  ipcMain.handle('marketplace:add', (_e, url: unknown) => marketplace.add(url))
  ipcMain.handle('marketplace:remove', (_e, id: unknown, uninstallExtensions: unknown) =>
    marketplace.remove(id, uninstallExtensions),
  )
  ipcMain.handle('marketplace:refresh', (_e, id: unknown) => marketplace.refresh(id))
  ipcMain.handle('marketplace:install', (_e, id: unknown, extId: unknown) =>
    marketplace.install(id, extId),
  )
  ipcMain.handle('marketplace:install-code', (_e, id: unknown, code: unknown) =>
    marketplace.installCode(id, code),
  )
  ipcMain.handle('marketplace:uninstall', (_e, extId: unknown) => marketplace.uninstall(extId))

  const dismissed = new DismissedSuggestions(
    join(app.getPath('userData'), 'extension-suggestions.json'),
  )
  ipcMain.handle('suggestions:for-file', (e, paneId: unknown, path: unknown) => {
    if (typeof paneId !== 'string' || typeof path !== 'string') return null
    if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return null
    const file = openFileGrants.confine(path)
    if (file === null) return null
    return suggestionFor(file, {
      servers: () => extensionHost?.languageServers() ?? [],
      extensions: () => extensionHost?.list() ?? [],
      listings: () => marketplace.languageListings(),
      dismissed: () => dismissed.list(),
      official: officialMarketplaceId,
      languageOf: editorLanguageOf,
    })
  })
  ipcMain.handle('suggestions:dismiss', (_e, extId: unknown) => dismissed.dismiss(extId))
  ipcMain.handle('suggestions:install', (_e, extId: unknown) =>
    marketplace.installSuggested(
      extId,
      OFFICIAL_MARKETPLACE,
      typeof extId === 'string' && Object.hasOwn(EXTENSION_SUGGESTIONS, extId),
    ),
  )
}

function forgetWorkspaceRequests(workspaceId: string): void {
  packageRequests.forget(workspaceId)
  void portForwarder.forget(workspaceId)
  portRequests.forget(workspaceId)
  domainRequests.forget(workspaceId)
}

function forgetSandboxRuntime(workspaceId: string): void {
  workspaceSandboxes.forget(workspaceId)
  sandboxViolations.clear(workspaceId)
  workspaceAgents.stop(workspaceId)
  secretService.forget(workspaceId)
}

const mergedSandboxes = new Set<string>()

function releaseMergedSandbox(workspaceId: string, exiting?: PtyEntry): void {
  if (!mergedSandboxes.has(workspaceId)) return
  for (const entry of ptys.values()) {
    if (entry !== exiting && entry.confinedBy === workspaceId) return
  }
  mergedSandboxes.delete(workspaceId)
  forgetSandboxRuntime(workspaceId)
}

function movePanesToWorkspace(paneIds: string[], sourceId: string, targetId: string): void {
  for (const paneId of paneIds) openWaits.paneMoved(paneId)
  for (const identity of moveToWorkspace(paneIds, targetId)) {
    emitPaneEvent('pane.created', {
      paneId: identity.externalId,
      workspaceId: targetId,
    })
  }
  for (const paneId of paneIds) {
    const entry = ptys.get(paneId)
    if (entry?.workspaceId === sourceId) entry.workspaceId = targetId
  }
}

function mergeWorkspace(sourceId: string, targetId: string): void {
  for (const identity of rehomeWorkspace(sourceId, targetId)) {
    emitPaneEvent('pane.created', {
      paneId: identity.externalId,
      workspaceId: targetId,
    })
  }
  for (const entry of ptys.values()) {
    if (entry.workspaceId === sourceId) entry.workspaceId = targetId
  }
  workspaceSandboxes.merge(sourceId, targetId)
  artifactFolders.merge(sourceId, targetId)
  artifactFolders.close(sourceId)
  removeWorkspace(sourceId)
  forgetWorkspaceRequests(sourceId)
  mergedSandboxes.add(sourceId)
  releaseMergedSandbox(sourceId)
}

function registerPtyIpc(): void {
  registerWorkspaceMergeIpc({
    ownerWindow: windowForWorkspace,
    hasManager: workspaceHasManager,
    sandboxRefusal: (sourceId, targetId) => workspaceSandboxes.mergeRefusal(sourceId, targetId),
    merge: mergeWorkspace,
  })
  registerPaneMoveIpc({
    ownerWindow: windowForWorkspace,
    paneOf: getByPaneId,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    movePanes: movePanesToWorkspace,
  })
  registerSandboxIpc({
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    missing: () => missingRequirements(SANDBOX_FEATURE),
    domains: domainRequests,
    ports: portRequests,
    violations: sandboxViolations,
    refreshAll: () => workspaceSandboxes.refreshAll(),
  })
  registerSystemRequirementsIpc({
    ownerWindow: windowForWorkspace,
    workDir: (workspaceId) => workDirForWorkspace(workspaceId),
    locale: readLocale,
    systemExtensionEnabled: () =>
      extensionHost?.list().some((ext) => ext.id === 'system' && ext.enabled) ?? false,
    missing: (feature) => missingRequirements(feature),
    label: requirementLabel,
    invokeInstall: (args, caller) =>
      extensionHost
        ? extensionHost.invoke('system', 'install', args, caller)
        : Promise.resolve({ ok: false, error: 'extension-unavailable' }),
  })
  ipcMain.handle('system:discrete-gpu', async (): Promise<DiscreteGpuInfo | null> => {
    if (process.platform !== 'linux') return null
    const gpu = discreteGpu(await querySwitcherooGpus())
    return gpu ? { name: gpu.name, inUse: gpuStartPlan(process.env, gpu).kind === 'stay' } : null
  })
  const attaching = new Map<string, Promise<PtyAttachResult>>()
  ipcMain.handle('pty:attach', async (e, paneId: string, opts: PtySpawnOptions) => {
    const previous = attaching.get(paneId)
    if (previous) await previous.catch(() => undefined)
    const pending = attachPty(e, paneId, opts)
    attaching.set(paneId, pending)
    try {
      return await pending
    } finally {
      if (attaching.get(paneId) === pending) attaching.delete(paneId)
    }
  })

  async function attachPty(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
  ): Promise<PtyAttachResult> {
    const subId = String(e.sender.id)
    if (!panesOwnedBy([paneId], subId)) {
      return { created: false, buffer: '', cursor: 0, dropped: false }
    }
    const mkSub = (entry: PtyEntry): Subscriber => {
      const role: SubscriberRole = opts.role === 'observer' ? 'observer' : 'owner'
      const lane = role === 'owner' ? entry.flow.open(subId, () => windowShown(subId)) : null
      const output = new CoalescedOutput((data) => {
        if (e.sender.isDestroyed()) return
        e.sender.send(`pty:data:${paneId}`, data)
        lane?.sent(data.length)
      })
      return {
        id: subId,
        role,
        send: (data) => output.push(data),
        flush: () => output.flush(),
        close: () => {
          output.close()
          lane?.close()
        },
      }
    }

    const existing = ptys.get(paneId)
    if (existing) {
      if (existing.killTimer) {
        clearTimeout(existing.killTimer)
        existing.killTimer = null
      }
      movingPanes.delete(paneId)
      recoveryHeld.delete(paneId)
      existing.subs.set(subId, e.sender)
      existing.session.addLiveSubscriber(mkSub(existing))
      const { data, cursor, dropped } = existing.session.since(opts.sinceCursor ?? 0)
      return {
        created: false,
        buffer: data,
        cursor,
        dropped,
        shell: shellName(existing.shell) || undefined,
        sandboxed: existing.sandboxed,
        ...(existing.sandboxStamp ? { sandboxStamp: existing.sandboxStamp } : {}),
        ...(existing.kept ? { kept: true } : {}),
        cols: existing.pty.cols,
        rows: existing.pty.rows,
      }
    }
    await keptShells.ready
    const keptShell = keptShells.claim(paneId)
    if (keptShell) return reattachKept(e, paneId, opts, keptShell, mkSub)
    if (keptShells.takeSandboxLost(paneId)) {
      return {
        created: false,
        buffer: sandboxFailureBanner(SANDBOX_LOST_WHILE_AWAY, []),
        cursor: 0,
        dropped: false,
        sandboxed: true,
      }
    }
    if (opts.attachOnly) return { created: false, buffer: '', cursor: 0, dropped: false }

    const mod = loadPty()
    if (!mod) {
      telemetry?.count('terminal', 'spawn_failure', 'node-pty-unavailable')
      return {
        created: false,
        buffer: '\r\n\x1b[38;2;239;89;111m node-pty unavailable — run: pnpm rebuild\x1b[0m\r\n',
        cursor: 0,
        dropped: false,
      }
    }
    const settings = readSettingsFile()
    const [shell, ...shellArgs] = shellArgv(
      settings.terminal?.shell,
      process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash'),
    )
    telemetry?.count('terminal', 'shell', shellFamily(shell))
    const resolved = attachWorkspace(getByPaneId(paneId)?.workspaceId, opts.workspaceId ?? '')
    if (!resolved.ok) {
      return {
        created: false,
        buffer: sandboxFailureBanner('the pane belongs to another workspace', []),
        cursor: 0,
        dropped: false,
      }
    }
    const identity = registerPane({ windowId: subId, workspaceId: resolved.workspaceId, paneId })
    const workspaceId = identity.workspaceId
    const integration = shellIntegrationSpawnOptions(
      shell,
      process.env,
      opts.ostiaPrompt ?? null,
      scratchFolders.historyFile(workspaceId),
    )
    const cols = opts.cols || 80
    const rows = opts.rows || 24
    const stateFile = join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID())
    let env = paneShellEnv({
      version: app.getVersion(),
      parent: process.env,
      integration: integration.env,
      pane: appEnv({
        PANE_ID: identity.externalId,
        START_DIR: opts.cwd ?? '',
        SOCKET: controlSocketPath(),
        CLI: join(app.getAppPath(), 'out/cli/index.js'),
        NODE: process.execPath,
        SHELL_STATE: stateFile,
      }),
      agentHooks: settings.agents?.hooks,
      artifactsDir: workspaceId ? artifactFolders.ensure(workspaceId) : null,
      launcherDir: paneLauncherDir(),
    })
    let secretNotice = ''
    let sandboxStamp: string | null = null
    let resizePipe: string | null = null
    let portBridge: PortBridge | null = null
    let file = shell
    let args = [...integration.args, ...shellArgs]
    const folder = spawnFolder(opts.cwd)
    let cwd = folder.cwd
    const host = opts.hostToken ? hostPaneGrants.consume(opts.hostToken) : false
    const sandboxed = !host && workspaceId !== '' && workspaceSandboxes.isEnabled(workspaceId)
    const wantsKeep = keepShellsOn() && !host
    let notKept = wantsKeep && !keptShellsProgram() ? TMUX_MISSING : ''
    let tokenFile: string | null = null
    if (sandboxed) {
      try {
        writeFileSync(stateFile, '', { mode: 0o600 })
        const secrets = await injectSecrets(workspaceId)
        secretNotice = secrets.notice
        resizePipe = needsPtyRelay(relayForced(app.isPackaged, process.env))
          ? join(workspaceSandboxes.tmpDir(workspaceId), `resize-${randomUUID()}`)
          : null
        portBridge = bridgesPorts(
          process.platform,
          workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
        )
          ? await PortBridge.open(workspaceSandboxes.tmpDir(workspaceId))
          : null
        if (wantsKeep && !notKept) {
          await workspaceSandboxes.connect(workspaceId)
          if (!workspaceSandboxes.isKept(workspaceId)) notKept = SANDBOX_NOT_KEPT
        }
        if (wantsKeep && !notKept) tokenFile = keptShells.writeToken(paneId, identity.token)
        const wrapped = await workspaceSandboxes.wrap(
          workspaceId,
          sandboxedShellCommand(
            quoteArgv([shell, ...args]),
            env.SHELL,
            resizePipe,
            portBridge?.command ?? null,
          ),
          'bash',
          tokenFile ? [stateFile, keptShells.attentionFile(paneId)] : [stateFile],
          tokenFile ? [tokenFile, keptShells.attentionFile(paneId)] : [],
        )
        sandboxStamp = workspaceSandboxes.wrapStamp(workspaceId)
        file = '/bin/sh'
        args = ['-c', wrapForTerminal(wrapped, resizePipe)]
        env = {
          ...sandboxSpawnEnv(env),
          ...packageCooldownEnv(
            workspaceSandboxes.packagePolicy(workspaceId).cooldownDays,
            Date.now(),
          ),
          ...secrets.env,
        }
        env.TMPDIR = workspaceSandboxes.tmpDir(workspaceId)
        cwd = sandboxCwd(cwd, workspaceSandboxes.workDir(workspaceId))
      } catch (err) {
        portBridge?.close()
        if (tokenFile) keptShells.removeToken(paneId)
        const missing = err instanceof SandboxUnavailableError ? err.missing : []
        onSandboxSpawnFailure?.(workspaceId, missing)
        return {
          created: false,
          buffer: sandboxFailureBanner(err instanceof Error ? err.message : String(err), missing),
          cursor: 0,
          dropped: false,
          sandboxed: true,
        }
      }
    }
    if (ptys.has(paneId)) {
      portBridge?.close()
      return attachPty(e, paneId, opts)
    }
    if (wantsKeep && !notKept && !tokenFile) {
      tokenFile = keptShells.writeToken(paneId, identity.token)
    }
    env = withPaneToken(env, identity.token, tokenFile)
    let kept: TmuxPane | null = null
    let keptMeta: KeptMeta | null = null
    if (wantsKeep && !notKept) {
      ensureKeptPlumbing()
      keptMeta = withKeptProcess({
        paneId,
        externalId: identity.externalId,
        workspaceId,
        shell,
        stateFile,
        spawnPath: env.PATH ?? '',
        ...(sandboxed
          ? { sandbox: { stamp: sandboxStamp, bridgeId: portBridge?.id ?? null, resizePipe } }
          : {}),
      })
      try {
        kept = await keptShells.spawn({
          file,
          args,
          cwd,
          env: keptPaneEnv(env),
          cols,
          rows,
          meta: keptMeta,
        })
      } catch (err) {
        notKept = err instanceof Error ? err.message : String(err)
        keptMeta = null
        appLog?.info('kept-spawn-failed', { pane: paneId, reason: notKept })
      }
      if (ptys.has(paneId)) {
        kept?.kill()
        return attachPty(e, paneId, opts)
      }
    }
    const pty: PaneProcess =
      kept ??
      mod.spawn(file, args, {
        name: PTY_TERM_NAME,
        cols,
        rows,
        cwd,
        env,
      })
    const entry = trackPty(paneId, pty, {
      kept,
      keptMeta,
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: env.PATH ?? '',
      stateFile,
      keepAlive: false,
      workspaceId,
      sandboxed,
      shell,
      sandboxStamp,
      portBridge,
    })
    const { session } = entry
    if (tokenFile) entry.exitListeners.add(() => keptShells.removeToken(paneId))
    if (sandboxed) {
      entry.exitListeners.add(() => {
        if (resizePipe) rmSync(resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
    }

    const history = takeRestoredScrollback(paneId)
    if (history) appLog?.info('scrollback-replay', { pane: paneId, chars: history.length })
    const seam = hibernatedPanes.delete(paneId) ? HIBERNATE_SEAM : RESTORE_SEAM
    if (history) feedPty(entry, `${history}${seam}`)
    if (secretNotice) feedPty(entry, secretNotice)
    if (notKept) feedPty(entry, keepShellsNotice(notKept))
    if (sandboxed && workspaceSandboxes.claimHomeNotice(workspaceId)) {
      const notice = hiddenHomeNotice()
      if (notice) feedPty(entry, notice)
    }
    if (history) entry.mirror.markRestored(history)

    pty.onData((d) => feedPty(entry, d))
    pty.onExit(({ exitCode }) => session.exit(exitCode))
    const { data, cursor, dropped } = session.since(0)
    session.addLiveSubscriber(mkSub(entry))
    if (folder.missing) telemetry?.count('terminal', 'spawn_failure', 'cwd-missing')
    return {
      created: true,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(shell) || undefined,
      sandboxed,
      host,
      ...(sandboxStamp ? { sandboxStamp } : {}),
      ...(kept ? { kept: true } : {}),
      ...(folder.missing ? { cwdMissing: true } : {}),
    }
  }

  async function reattachKept(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    kept: KeptShell,
    mkSub: (entry: PtyEntry) => Subscriber,
  ): Promise<PtyAttachResult> {
    const subId = String(e.sender.id)
    const { pane, meta } = kept
    const identity = adoptPane({ windowId: subId, workspaceId: meta.workspaceId, paneId })
    if (identity.externalId !== meta.externalId) {
      appLog?.info('kept-pane-id-changed', { pane: paneId })
    }
    ensureKeptPlumbing()
    const savedAttention = keptShells.savedAttention(paneId)
    keptShells.writeToken(paneId, identity.token)
    keptAttention.reattached(paneId, agentRunning.has(paneId))
    takeRestoredScrollback(paneId)
    hibernatedPanes.delete(paneId)
    const cols = opts.cols || pane.cols
    const rows = opts.rows || pane.rows
    const sandbox = meta.sandbox
    const workspaceId = meta.workspaceId
    const keptHost = sandbox ? keptShells.keptHost(workspaceId) : undefined
    if (keptHost) workspaceSandboxes.adoptKeptTmp(workspaceId, keptHost.tmpDir)
    const portBridge = sandbox?.bridgeId
      ? await PortBridge.open(workspaceSandboxes.tmpDir(workspaceId), undefined, sandbox.bridgeId)
      : null
    const entry = trackPty(paneId, pane, {
      kept: pane,
      keptMeta: meta,
      cols,
      rows,
      subs: new Map([[subId, e.sender]]),
      spawnPath: meta.spawnPath,
      stateFile: meta.stateFile,
      keepAlive: false,
      workspaceId,
      shell: meta.shell,
      sandboxed: sandbox !== undefined,
      sandboxStamp: sandbox?.stamp ?? null,
      portBridge,
    })
    if (sandbox) {
      entry.exitListeners.add(() => {
        if (sandbox.resizePipe) rmSync(sandbox.resizePipe, { force: true })
        portBridge?.close()
        void workspaceSandboxes.cleanup(workspaceId)
        releaseMergedSandbox(workspaceId, entry)
      })
      portRequests.keep(workspaceId, keptHost?.exposed ?? [])
      void workspaceSandboxes.connect(workspaceId).catch(() => undefined)
    }
    pane.onData((d) => feedPty(entry, d))
    pane.onExit(({ exitCode }) => entry.session.exit(exitCode))
    let screen = ''
    try {
      screen = await pane.snapshot(cols, rows)
    } catch {}
    feedPty(entry, `${RESTORE_SEAM}${screen}`)
    if (meta.process) {
      processes?.adopt(
        {
          ...meta.process,
          cwd: meta.process.cwd,
          workspaceId: meta.workspaceId,
          paneId,
          externalPaneId: identity.externalId,
        },
        entry.session.cursor,
      )
    }
    pane.live()
    const { data, cursor, dropped } = entry.session.since(0)
    entry.session.addLiveSubscriber(mkSub(entry))
    if (savedAttention) restoreKeptAttention(identity, savedAttention)
    return {
      created: false,
      buffer: data,
      cursor,
      dropped,
      shell: shellName(meta.shell) || undefined,
      sandboxed: sandbox !== undefined,
      ...(sandbox?.stamp ? { sandboxStamp: sandbox.stamp } : {}),
      kept: true,
      reattached: true,
    }
  }

  ipcMain.on('pty:detach', (e, paneId: string) => {
    const entry = ptys.get(paneId)
    if (!entry) return
    const subId = String(e.sender.id)
    entry.subs.delete(subId)
    entry.session.removeSubscriber(subId)
  })

  ipcMain.handle('pty:hibernate', async (_e, raw: string): Promise<HibernateOutcome> => {
    const paneId = String(raw)
    const entry = ptys.get(paneId)
    if (!entry) return 'no-terminal'
    const busy = backgroundWork(agentWork.reason(paneId), await readProcessTable(), entry.pty.pid)
    if (busy) return busy
    return ptys.get(paneId) === entry && hibernatePty(paneId) ? 'hibernated' : 'no-terminal'
  })

  ipcMain.handle('pty:stashed', (e, paneId: string): string | null =>
    stashedScreen(String(paneId), String(e.sender.id), windowOfPane(String(paneId))),
  )

  ipcMain.handle('pty:restart', (e, paneId: string): boolean => {
    const entry = ptys.get(String(paneId))
    if (!entry?.subs.has(String(e.sender.id))) return false
    killPty(String(paneId), 'restart')
    return true
  })

  ipcMain.on('pty:agent-running', (e, paneId: unknown, running: unknown) => {
    if (typeof paneId !== 'string' || typeof running !== 'boolean') return
    const attached = ptys.get(paneId)?.subs.has(String(e.sender.id)) === true
    agentRunning.report(paneId, running, attached)
  })

  ipcMain.on('pty:ack', (e, paneId: unknown, chars: unknown) => {
    if (typeof paneId !== 'string' || typeof chars !== 'number') return
    ptys.get(paneId)?.flow.ack(String(e.sender.id), chars)
  })
  app.on('render-process-gone', (_e, contents) => {
    releasePtyFlow(String(contents.id))
    openWaits.windowGone(String(contents.id))
  })

  ipcMain.on('pty:waking', (e, paneId: unknown, waking: unknown) => {
    if (typeof paneId !== 'string' || typeof waking !== 'boolean') return
    if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return
    if (waking) paneWaking.start(paneId)
    else paneWaking.end(paneId, 'failed')
  })

  ipcMain.on('pty:write', (e, paneId: string, data: string) => {
    const entry = ptys.get(paneId)
    if (entry?.session.canWrite(String(e.sender.id))) entry.pty.write(data)
  })
  ipcMain.handle('pty:foreground', (e, paneId: string): string | null => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return null
    try {
      const name = entry.pty.process
      return typeof name === 'string' && name ? (name.split('/').pop() ?? null) : null
    } catch {
      return null
    }
  })
  ipcMain.handle('pty:activity', (e, paneId: string): PaneActivity | null => {
    const entry = ptys.get(String(paneId))
    if (!entry?.subs.has(String(e.sender.id))) return null
    return paneActivity(entry)
  })
  ipcMain.handle('pty:commands', async (e, paneId: string): Promise<string[]> => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id))) return []
    if (!holdsLocalPrompt(entry)) return []
    const state = await readShellState(entry.stateFile)
    const path = state?.path ?? entry.spawnPath
    const rules = sandboxReadRules(entry)
    return commandNames(executables, rules ? sandboxPath(path, rules) : path, state?.names ?? [])
  })
  ipcMain.handle('pty:local-prompt', (e, paneId: string): boolean => {
    const entry = ptys.get(paneId)
    return entry?.subs.has(String(e.sender.id)) === true && holdsLocalPrompt(entry)
  })
  ipcMain.handle('pty:list-dir', (e, paneId: string, dir: string): FsEntry[] => {
    const entry = ptys.get(paneId)
    if (!entry?.subs.has(String(e.sender.id)) || !holdsLocalPrompt(entry)) return []
    const safe = resolveSafe(dir, fileRoots())
    if (safe === null) return []
    const rules = sandboxReadRules(entry)
    const entries = listDir(safe)
    return rules ? sandboxEntries(safe, entries, rules) : entries
  })
  ipcMain.handle(
    'pty:prompt-context',
    async (e, paneId: string, want: PromptContextRequest): Promise<PromptContext | null> => {
      const entry = ptys.get(paneId)
      if (!entry?.subs.has(String(e.sender.id))) return null
      const state = await readShellState(entry.stateFile)
      return promptContext(
        state,
        entry.spawnPath,
        terminalState.get(paneId)?.cwd,
        { node: want?.node === true, kube: want?.kube === true },
        promptSources,
      )
    },
  )
  ipcMain.on('pty:resize', (_e, paneId: string, cols: number, rows: number) => {
    const entry = ptys.get(paneId)
    if (!entry?.keepAlive) resizePty(entry, cols, rows)
  })
}

function trackPty(
  paneId: string,
  pty: PaneProcess,
  opts: {
    cols: number
    rows: number
    subs: Map<string, Electron.WebContents>
    spawnPath: string
    stateFile: string
    keepAlive: boolean
    workspaceId?: string
    sandboxed?: boolean
    shell?: string
    sandboxStamp?: string | null
    portBridge?: PortBridge | null
    kept?: TmuxPane | null
    keptMeta?: KeptMeta | null
  },
): PtyEntry {
  const spawnedAt = Date.now()
  const session = new PtySession({
    capBytes: PTY_BUFFER_CAP,
    onNoOwners: () => {
      if (
        ptys.get(paneId) !== entry ||
        entry.killTimer ||
        entry.keepAlive ||
        movingPanes.has(paneId)
      ) {
        return
      }
      scheduleReap(paneId, entry)
    },
    onExit: (code) => {
      appLog?.info('pty-exit', { pane: paneId, code })
      if (entry.killTimer) clearTimeout(entry.killTimer)
      entry.killTimer = null
      const closes = closesPaneOnExit({
        ownExit: ptys.get(paneId) === entry,
        code,
        livedMs: Date.now() - spawnedAt,
      })
      for (const wc of entry.subs.values()) {
        if (!wc.isDestroyed()) wc.send(`pty:exit:${paneId}`, code, closes)
      }
      for (const listener of entry.exitListeners) listener(code)
      processes?.shellEnded(paneId, (from) => session.since(from))
      entry.flow.dispose()
      entry.mirror.dispose()
      removeStateFile(entry)
      if (ptys.get(paneId) === entry) {
        ptys.delete(paneId)
        openWaits.callerExited(paneId)
        movingPanes.delete(paneId)
        agentRunning.shellEnded(paneId)
        agentWork.clear(paneId)
        keptAttention.reported(paneId)
        recoveryHeld.delete(paneId)
        closedPanes.delete(paneId)
      }
    },
  })
  const entry: PtyEntry = {
    paneId,
    pty,
    session,
    flow: new PtyFlowControl({
      pause: () => pausePty(entry, true),
      resume: () => pausePty(entry, false),
    }),
    mirror: new ScreenMirror(opts.cols, opts.rows),
    subs: opts.subs,
    killTimer: null,
    spawnPath: opts.spawnPath,
    stateFile: opts.stateFile,
    keepAlive: opts.keepAlive,
    exitListeners: new Set(),
    workspaceId: opts.workspaceId ?? '',
    sandboxed: opts.sandboxed ?? false,
    shell: opts.shell ?? '',
    sandboxStamp: opts.sandboxStamp ?? null,
    portBridge: opts.portBridge ?? null,
    confinedBy: opts.sandboxed ? (opts.workspaceId ?? '') : null,
    kept: opts.kept ?? null,
    keptMeta: opts.keptMeta ?? null,
  }
  ptys.set(paneId, entry)
  return entry
}

function paneEnv(paneId: string, windowId: string, cwd: string): Record<string, string> {
  const identity = registerPane({ windowId, workspaceId: '', paneId })
  return appEnv({
    PANE_ID: identity.externalId,
    TOKEN: identity.token,
    START_DIR: cwd,
    SOCKET: controlSocketPath(),
    CLI: join(app.getAppPath(), 'out/cli/index.js'),
    NODE: process.execPath,
  })
}

function managerLaunchArgv(argv: string[], resume: AgentResume | null): string[] {
  const { skills } = managerSettings()
  const base = privateTmpDir(`${PRODUCT_NAME}-manager`)
  const claudePluginDir = join(base, 'claude-plugin')
  writeManagerClaudePlugin(claudePluginDir, skills)
  const codexContextFile = writeManagerCodexContext(join(base, 'codex'), skills)
  return managerArgv(argv, { claudePluginDir, codexContextFile, resume })
}

const managerResumePath = (): string => storePath('manager-resume', 'global')
const scriptTokensPath = (): string => storePath('script-tokens-v2', 'global')
const retiredScriptTokensPath = (): string => storePath('retired-script-tokens', 'global')

function spawnManagerPty(req: {
  paneId: string
  argv: string[]
  cwd: string
  cols: number
  rows: number
  path?: string
  resume: AgentResume | null
  onExit: () => void
}): boolean {
  const mod = loadPty()
  const windowId = getByPaneId(req.paneId)?.windowId || primaryWindowId()
  const [file, ...args] = managerLaunchArgv(req.argv, req.resume)
  if (!mod || !windowId || !file) return false
  const { cwd } = spawnFolder(req.cwd)
  const env = {
    ...process.env,
    ...(req.path === undefined ? {} : { PATH: req.path }),
    ...paneEnv(req.paneId, windowId, cwd),
    ...PTY_COLOR_ENV,
    ...ptyIdentityEnv(app.getVersion()),
  } as Record<string, string>
  const identity = markManager(req.paneId)
  if (identity) setCaps(identity.externalId, MANAGER_CAPABILITIES)
  let pty: IPty
  try {
    pty = mod.spawn(file, args, {
      name: PTY_TERM_NAME,
      cols: req.cols,
      rows: req.rows,
      cwd,
      env,
    })
  } catch (err) {
    console.error('[manager] spawn failed', err)
    return false
  }
  const entry = trackPty(req.paneId, pty, {
    cols: req.cols,
    rows: req.rows,
    subs: new Map(),
    spawnPath: env.PATH ?? '',
    stateFile: join(privateTmpDir(`${PRODUCT_NAME}-shell-state`), randomUUID()),
    keepAlive: true,
  })
  entry.exitListeners.add(() => req.onExit())
  pty.onData((d) => feedPty(entry, d))
  pty.onExit(({ exitCode }) => entry.session.exit(exitCode))
  return true
}

const MIRROR_SUBSCRIBER = 'portal-mirror'

function attachMirror(paneId: string, sink: MirrorSink): MirrorHandle | null {
  const entry = ptys.get(paneId)
  if (!entry) return null
  const onExit = (code: number): void => sink.exit(code)
  entry.exitListeners.add(onExit)
  entry.session.addSubscriber(
    { id: MIRROR_SUBSCRIBER, role: 'owner', send: (data) => sink.data(data) },
    0,
  )
  return {
    write: (data) => {
      if (ptys.get(paneId) === entry) entry.pty.write(data)
    },
    resize: (cols, rows) => {
      if (ptys.get(paneId) !== entry) return
      if (entry.pty.cols === cols && entry.pty.rows === rows) return
      resizePty(entry, cols, rows)
      for (const wc of entry.subs.values()) {
        if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
      }
    },
    detach: () => {
      entry.exitListeners.delete(onExit)
      entry.session.removeSubscriber(MIRROR_SUBSCRIBER)
    },
  }
}

const FILE_WATCH_DEBOUNCE_MS = 150
let fileWatches: FileWatches | null = null

function registerFsIpc(): void {
  const allowedRoots = fileRoots()
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  registerOpenPathIpc(allowedRoots)
  registerTerminalPathLinkIpc(
    new TerminalPathLinks({
      grants: openFileGrants,
      home: homedir(),
      output: (paneId) => paneOutput(paneId),
      pane: (paneId) => getByPaneId(paneId),
      isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
      isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
      openFolder: (path) => shell.openPath(path),
    }),
  )
  registerProjectRootIpc(allowedRoots)
  registerSearchIpc(ripgrepPath(app.getAppPath(), process.platform, process.arch), allowedRoots)

  const fileOps = new FileOps({ roots: allowedRoots, trash: (path) => shell.trashItem(path) })
  ipcMain.handle('files:create', (_e, dir: unknown, name: unknown, kind: unknown) =>
    fileOps.create(dir, name, kind),
  )
  ipcMain.handle('files:rename', (_e, path: unknown, name: unknown) => fileOps.rename(path, name))
  ipcMain.handle('files:move', (_e, paths: unknown, dir: unknown) => fileOps.move(paths, dir))
  ipcMain.handle('files:copy', (_e, paths: unknown, dir: unknown) => fileOps.copy(paths, dir))
  ipcMain.handle('files:trash', (_e, paths: unknown) => fileOps.trash(paths))

  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] => {
    const safe = resolveSafe(dir, allowedRoots)
    if (safe === null) return []
    return listDir(safe)
  })

  ipcMain.handle('fs:stat', (_e, path: string): FsKind | null => {
    const safe = openFileGrants.confine(path)
    if (safe === null) return null
    try {
      const stat = statSync(safe)
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:read', (_e, path: unknown) =>
    readTextConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('fs:read-binary', (_e, path: unknown) =>
    readBinaryConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('files:admit-dropped', (_e, paths: unknown, workspaceId: unknown) => {
    if (!Array.isArray(paths) || paths.length > OPEN_FILES_MAX) return []
    const remember = typeof workspaceId !== 'string' || !scratchFolders.isScratch(workspaceId)
    return paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => openFileGrants.admit(path, { sandboxed: false, remember }))
  })

  fileWatches = new FileWatches({
    confine: (path) => openFileGrants.confine(path),
    debounceMs: FILE_WATCH_DEBOUNCE_MS,
    onChange: ({ path, exists, owners }) => {
      for (const owner of owners) {
        const win = windows.get(owner)
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path, exists })
      }
    },
  })
  ipcMain.handle('fs:watch', (e, path: unknown): boolean =>
    typeof path === 'string' ? (fileWatches?.watch(String(e.sender.id), path) ?? false) : false,
  )
  ipcMain.on('fs:unwatch', (e, path: unknown) => {
    if (typeof path === 'string') fileWatches?.unwatch(String(e.sender.id), path)
  })

  ipcMain.handle('fs:version', (_e, path: unknown) =>
    versionConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('fs:write', async (e, path: string, content: string): Promise<boolean> => {
    const safe = openFileGrants.confine(path)
    if (safe === null) return false
    try {
      const save = () => writeText(safe, content)
      await (fileWatches?.write(String(e.sender.id), safe, content, save) ?? save())
      if (safe === settingsFile) {
        settingsChanged()
        telemetry?.settingsChanged()
        refreshCapabilitySettings()
        extensionHost?.refreshLocale()
        extensionHost?.reloadAssistSettings()
        gitService?.settingsChanged()
        portsService?.settingsChanged()
        applyGlobalHotkey()
        releaseChecks?.settingsChanged()
      }
      return true
    } catch {
      return false
    }
  })
}

function settingsChanged(): void {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed')
  }
}

export function listCommandsFor(windowId: string): CommandDescriptor[] {
  return commandsByWindow.get(windowId) ?? []
}

export function getTerminalState(paneId: string): TerminalStateSnapshot | undefined {
  return terminalState.get(paneId)
}

function primaryWindowId(): string | undefined {
  return broker?.windowIds()[0] ?? [...windows.keys()][0]
}

function windowIds(): string[] {
  return broker?.windowIds() ?? [...windows.keys()]
}

const workspaceWindowId = firstKnownOwner(
  (workspaceId) => broker?.windowOfWorkspace(workspaceId),
  windowOfWorkspace,
  windowForWorkspace,
)

function openSettingsInFocusedWindow(): void {
  const focused = BrowserWindow.getFocusedWindow()
  const entry = [...windows].find(([, win]) => win === focused)
  void execCommand({ windowId: entry?.[0], workspaceId: '', paneId: null }, 'app.openSettings')
}

function runMenuCommandInFocusedWindow(command: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const win = focused && [...windows.values()].includes(focused) ? focused : mainWindow()
  if (win && !win.isDestroyed()) win.webContents.send('app-menu:run', command)
}

function mainWindow(): BrowserWindow | undefined {
  return broker?.mainWindow() ?? [...windows.values()][0]
}

let gwSubSeq = 0

export function attachPhoneObserver(
  rendererPaneId: string,
  opts: {
    sinceCursor?: number
    role?: 'observer' | 'owner'
    sendData: (data: string) => void
  },
): { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null {
  const entry = ptys.get(rendererPaneId)
  if (!entry) return null
  const id = `gw-${++gwSubSeq}`
  const role: SubscriberRole = opts.role === 'owner' ? 'owner' : 'observer'
  const { cursor, dropped } = entry.session.addSubscriber(
    { id, role, send: (data) => opts.sendData(data) },
    opts.sinceCursor ?? 0,
  )
  return {
    cursor,
    dropped,
    cols: entry.pty.cols,
    rows: entry.pty.rows,
    detach: () => entry.session.removeSubscriber(id),
  }
}

export function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
  resizePty(ptys.get(rendererPaneId), cols, rows)
}

export function ptyWrite(rendererPaneId: string, data: string): void {
  ptys.get(rendererPaneId)?.pty.write(data)
}

let reqSeq = 0

export function execCommand(
  target: CommandTarget,
  id: string,
  args?: unknown,
): Promise<CommandResult> {
  const win = target.windowId ? windows.get(target.windowId) : mainWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve({
      ok: false,
      error: { code: 'command-failed', message: 'target window not available' },
    })
  }
  const reqId = `cmd-${++reqSeq}`
  return new Promise((resolve) => {
    const onResult = (_e: Electron.IpcMainEvent, rid: string, result: CommandResult): void => {
      if (rid !== reqId) return
      clearTimeout(timer)
      ipcMain.removeListener('command:result', onResult)
      resolve(result)
    }
    ipcMain.on('command:result', onResult)
    win.webContents.send('command:invoke', reqId, { id, args, target })
    const timer = setTimeout(() => {
      ipcMain.removeListener('command:result', onResult)
      resolve({ ok: false, error: { code: 'command-failed', message: 'command timed out' } })
    }, 5000)
  })
}

function publishWorkspaceChips(chips: WorkspaceChip[]): void {
  for (const [windowId, win] of windows) {
    if (win.isDestroyed()) continue
    win.webContents.send(
      'extensions:workspace-chips',
      workspaceChipsForWindow(chips, workspaceWindowId, windowId),
    )
  }
}

function sendToWindow(windowId: string, channel: string, payload: unknown): void {
  const win = windows.get(windowId)
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function startCoreBoards(): void {
  const panes = () =>
    listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking })
  const service = new GitService({
    settings: () => parseGitSettings(readSettingsFile().git),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    listPanes: panes,
    send: sendToWindow,
    log: (line) => console.error(`[git] ${line}`),
  })
  gitService = service
  const commands = new GitCommands({
    settings: () => parseGitSettings(readSettingsFile().git),
    text: () => mainStrings().git,
    cwdOf: (workspaceId) => service.cwdOf(workspaceId),
    views: new ViewStateStore(join(app.getPath('userData'), 'git-view.json')),
    openDiff: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    confirmDiscard: (prompt) => confirmDiscard(prompt, windows.values()),
    touched: () => service.touched(),
  })
  registerGitMethods({
    commands,
    callerOf: (identity) => ({
      workspaceId: identity.workspaceId,
      workDir: workDirForWorkspace(identity.workspaceId),
      cwd: terminalState.get(identity.paneId)?.cwd,
    }),
  })
  registerGitIpc({
    commands,
    service,
    ownerWindow: workspaceWindowId,
    workDirOf: workDirForWorkspace,
  })
  const ports = new PortsService({
    settings: () => parsePortsSettings(readSettingsFile().ports),
    listPanes: panes,
    rendererPaneId: (externalId) => resolveExternal(externalId)?.paneId,
    send: sendToWindow,
    log: (line) => console.error(`[ports] ${line}`),
  })
  portsService = ports
  registerPortsMethods(ports)
  registerPortsIpc(ports)
}

function sendToWorkspaceWindow(
  workspaceId: string | undefined,
  channel: string,
  payload: unknown,
): void {
  const windowId = workspaceId ? workspaceWindowId(workspaceId) : undefined
  const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function extensionSecretStore() {
  return encryptedStore(storePath('extension-secrets', 'global'))
}

function assistKeyStore() {
  return encryptedStore(storePath('assist-keys', 'global'))
}

function encryptedFile(path: string): SecretStoreDeps {
  return {
    load: () => loadJson<unknown>(path, {}),
    save: (data) => saveJson(path, data, { secure: true }),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
  }
}

function encryptedStore(path: string) {
  return createSecretStore(encryptedFile(path))
}

function readSettingsFileOrNull(): { assistant?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'),
    )
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
}

function readSettingsFile(): {
  locale?: unknown
  extensionSettings?: unknown
  git?: unknown
  ports?: unknown
  workspaces?: { globalHotkey?: unknown }
  manager?: unknown
  assistant?: unknown
  privacy?: unknown
  terminal?: { shell?: unknown; keepShells?: unknown }
  agents?: { hooks?: unknown }
} {
  try {
    return JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8'))
  } catch {
    return {}
  }
}

function readLocale(): string | undefined {
  const locale = readSettingsFile().locale
  return typeof locale === 'string' ? locale : undefined
}

const languagePackDeps = {
  languages: () => extensionHost?.languages() ?? [],
  onError: (extId: string, error: string) => console.warn(`[language pack ${extId}] ${error}`),
}

const mainStrings = createMainStrings({ ...languagePackDeps, locale: readLocale })

const agentOffers = createAgentOfferRelay({
  windowOf: (workspaceId) => workspaceWindowId(workspaceId),
  send: (windowId, channel, payload) => {
    const win = windows.get(windowId)
    if (!win || win.isDestroyed()) return false
    win.webContents.send(channel, payload)
    return true
  },
  externalIdOf: (paneId) => getByPaneId(paneId)?.externalId,
})

function focusPaneInWindow(pane: PaneIdentity): boolean {
  const win = windows.get(pane.windowId)
  if (!win || win.isDestroyed()) return false
  showWindow(win)
  win.webContents.send('extensions:focus-pane', pane.paneId)
  return true
}

const OPEN_TERMINAL_TIMEOUT_MS = 5000
let openTerminalSeq = 0

function openTerminalInWindow(req: ProcessTabRequest): Promise<string | null> {
  const { windowId: requestedWindow, ...payload } = req
  const windowId =
    requestedWindow ?? (req.workspaceId ? workspaceWindowId(req.workspaceId) : undefined)
  const win = (windowId ? windows.get(windowId) : undefined) ?? mainWindow()
  if (!win || win.isDestroyed()) return Promise.resolve(null)
  const wid = String(win.webContents.id)
  const requestId = `term-${++openTerminalSeq}`
  return new Promise((resolve) => {
    const finish = (paneId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('extensions:open-terminal-result', onResult)
      resolve(paneId)
    }
    const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
      if (rid !== requestId || String(e.sender.id) !== wid) return
      finish(
        typeof paneId === 'string' && paneId
          ? registerPane({ windowId: wid, workspaceId: req.workspaceId ?? '', paneId }).externalId
          : null,
      )
    }
    const timer = setTimeout(() => finish(null), OPEN_TERMINAL_TIMEOUT_MS)
    ipcMain.on('extensions:open-terminal-result', onResult)
    win.webContents.send('extensions:open-terminal', { ...payload, requestId })
  })
}

const MANAGER_READY_TIMEOUT_MS = 20_000
const MANAGER_OPEN_TIMEOUT_MS = 5000
const managerReadyWindows = new Set<string>()
const managerReadyWaiters = new Set<() => void>()
let managerOpenSeq = 0

function registerManagerIpc(): void {
  ipcMain.on('manager:ready', (e) => {
    managerReadyWindows.add(String(e.sender.id))
    for (const wake of managerReadyWaiters) wake()
    managerReadyWaiters.clear()
  })
}

function managerWindow(): Promise<BrowserWindow | null> {
  const ready = (): BrowserWindow | null => {
    const id = managerWindowId(primaryWindowId(), managerReadyWindows)
    const win = id ? windows.get(id) : undefined
    return win && !win.isDestroyed() ? win : null
  }
  const now = ready()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      managerReadyWaiters.delete(wake)
      resolve(ready())
    }
    const timer = setTimeout(wake, MANAGER_READY_TIMEOUT_MS)
    managerReadyWaiters.add(wake)
  })
}

async function createManagerPane(req: { agent: string; cwd: string }): Promise<string | null> {
  const win = await managerWindow()
  if (!win) return null
  const wid = String(win.webContents.id)
  const requestId = `manager-${++managerOpenSeq}`
  return new Promise((resolve) => {
    const finish = (paneId: string | null): void => {
      clearTimeout(timer)
      ipcMain.removeListener('manager:open-result', onResult)
      resolve(paneId)
    }
    const onResult = (e: Electron.IpcMainEvent, rid: unknown, paneId: unknown): void => {
      if (rid !== requestId || String(e.sender.id) !== wid) return
      finish(typeof paneId === 'string' && paneId ? paneId : null)
    }
    const timer = setTimeout(() => finish(null), MANAGER_OPEN_TIMEOUT_MS)
    ipcMain.on('manager:open-result', onResult)
    win.webContents.send('manager:open', requestId, req)
  })
}

function managerSettings() {
  return parseManagerSettings(readSettingsFile().manager)
}

function revealWindow(windowId: string): void {
  const win = windows.get(windowId)
  if (win && !win.isDestroyed() && !win.isVisible()) appTray?.showWindows()
}

async function openWorker(req: {
  argv: string[]
  cwd?: string
  workspaceId?: string
  name?: string
}): Promise<string | null> {
  let workspaceId = req.workspaceId
  if (!workspaceId) {
    const created = await reach.byAgent(() =>
      execCommand({ workspaceId: '', paneId: null }, 'workspace.new', {
        ...(req.cwd ? { dir: req.cwd } : {}),
        ...(req.name ? { name: req.name } : {}),
      }),
    )
    const result = created.ok ? (created.result as { workspaceId?: unknown }) : undefined
    if (typeof result?.workspaceId !== 'string') return null
    workspaceId = result.workspaceId
  }
  return openTerminalInWindow({
    command: quoteArgv(req.argv),
    workspaceId,
    ...(req.cwd ? { cwd: req.cwd } : {}),
    title: req.argv[0],
  })
}

function startPortal(): void {
  if (!managerService || !portalSupported(process.platform)) return
  const service = managerService
  portal = new Portal(portalSocketPath(app.isPackaged), {
    missing: () => missingRequirements(MANAGER_FEATURE),
    hint: (missing) => installHint(missing),
    judge: (socket) =>
      callerVerdict(socket, {
        mainPid: process.pid,
        paneTtys: ttysOf(
          [...ptys.values()].map((entry) => entry.pty.pid),
          procFs,
        ),
        proc: procFs,
      }),
    manager: service,
    attachMirror,
  })
  portal
    .start()
    .then((started) => {
      if (!started) console.warn(`[portal] another ${PRODUCT_DISPLAY_NAME} owns the portal socket`)
    })
    .catch((err) => console.error('[portal] failed to start', err))
}

function emitFocusChanged(): void {
  const focused = BrowserWindow.getFocusedWindow() !== null
  extensionHost?.emitEvent('focus.changed', { focused })
  gitService?.setFocused(focused)
  portsService?.setFocused(focused)
}

function showWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleAllWindows(): void {
  toggleWindows(BrowserWindow.getAllWindows(), appTray, revealApp)
}

function applyGlobalHotkey(): void {
  const status = globalHotkey?.apply(readSettingsFile().workspaces?.globalHotkey)
  if (status === 'taken') console.warn('[global hotkey] the chosen shortcut is in use elsewhere')
}

function revealApp(): void {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(MAIN_SLOT, broker?.restoredBounds(MAIN_SLOT))
  } else appTray?.showWindows()
}

app.on('second-instance', (_event, argv) => {
  if (!app.isReady() || isHiddenLaunch(argv)) return
  revealApp()
})

app.whenReady().then(() => {
  setPaneIdSalt(loadPaneIdSalt(storePath('pane-id-salt', 'global')))
  const appMenu = installAppMenu(process.platform, {
    productName: PRODUCT_DISPLAY_NAME,
    openSettings: openSettingsInFocusedWindow,
    runCommand: runMenuCommandInFocusedWindow,
  })
  ipcMain.on('app-menu:set', (e, spec: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && [...windows.values()].includes(win)) appMenu.setSpec(spec)
  })
  const logDir = join(app.getPath('userData'), 'logs')
  appLog = createAppLog(join(logDir, LOG_FILE_NAME))
  telemetry = registerTelemetry({
    file: join(app.getPath('userData'), TELEMETRY_FILE),
    version: appVersion(),
    stamp: runningBuild()?.telemetry,
    readSettings: readSettingsFile,
    locale: readLocale,
    session: telemetrySessionFacts,
    log: (event, fields) => appLog?.info(event, fields),
  })
  diagnostics = registerDiagnostics({
    log: appLog,
    telemetry,
    version: appVersion(),
    logDir,
    testHooks: process.env.NODE_ENV === 'test',
    startRecovery,
    finishRecovery,
    openPath: (path) => shell.openPath(path),
  })
  handleQuitSignals()
  restoreOutcome = loadRestoredScrollback()
  appLog?.info('scrollback-load', {
    outcome: restoreOutcome,
    panes: Object.keys(pendingRestoredScrollback()).length,
  })
  void keptShells
    .start(parseKeepShells(readSettingsFile().terminal?.keepShells), savedPaneIds())
    .then(() => {
      const kept = keptShells.keptHostWorkspaces()
      for (const workspaceId of kept) {
        const host = keptShells.keptHost(workspaceId)
        if (host) workspaceSandboxes.adoptKeptTmp(workspaceId, host.tmpDir)
      }
      workspaceSandboxes.sweepKeptTmp(kept)
    })
  try {
    writeOstiaLauncher(paneLauncherDir())
  } catch (err) {
    appLog?.warn('launcher-write-failed', {
      launcher: 'pane',
      code: (err as NodeJS.ErrnoException).code ?? null,
    })
  }
  scratchFolders.sweep()
  artifactFolders.sweep()
  workspaceSandboxes.sweepTmp()
  registerScratchIpc(scratchFolders)
  registerArtifactIpc({
    folders: artifactFolders,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerCmuxSessionIpc()
  clipboardEdits = registerClipboardEdits({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    availableFormats: async () => (await clipboard.read()).flatMap((item) => item.types),
    mac: process.platform === 'darwin',
  })
  guestChords = registerGuestChords({
    ipc: ipcMain,
    isAppWindow: (sender) => windows.get(String(sender.id))?.webContents === sender,
    mac: process.platform === 'darwin',
  })
  registerIpc()
  registerPtyIpc()
  registerFsIpc()
  registerSelectionIpc(reachesPane, redactor.text)
  registerPreviewIpc(previews)
  registerPrivacyIpc(redactor)
  const approvalCaps = new Map<string, readonly string[]>()
  registerApprovals(revealWindow, settingsChanged, {
    opened: (request) => {
      approvalCaps.set(request.id, request.caps)
      for (const cap of request.caps) telemetry?.count('agents', 'approval_shown', cap)
      askHub.approvalOpened(request)
    },
    settled: (id, outcome) => {
      const caps = approvalCaps.get(id) ?? []
      approvalCaps.delete(id)
      if (outcome !== 'timeout' && outcome !== 'auto') {
        for (const cap of caps) telemetry?.count('agents', 'approval_answered', cap)
      }
      askHub.settled(id, outcome)
    },
  })
  registerQuestions({
    opened: (request) => {
      telemetry?.count('agents', 'question_asked')
      askHub.questionOpened(request)
    },
    settled: (id, outcome) => {
      if (outcome === 'answered') telemetry?.count('agents', 'question_answered')
      askHub.settled(id, outcome)
    },
  })
  registerPermissionAsk({ questions, phoneCanAnswer: phoneCanRespond })
  registerCredentials()
  registerAppUpdate(() => {
    restartRequested = true
    requestQuit()
  })
  updateRunner = createUpdateRunner({
    method: installMethod,
    title: () => mainStrings().native.updateTitle,
    openTerminal: (req) => openTerminalInWindow(req),
    hostToken: (command) => {
      hostPaneGrants.offer(UPDATE_HOST_GRANT_ID, command)
      return hostPaneGrants.claim(UPDATE_HOST_GRANT_ID, command) ?? ''
    },
    onChange: announceUpdateRun,
  })
  const sweepFile = storePath('install-replace', 'global')
  void sweepOldInstall(
    loadJson<PendingSweep | null>(sweepFile, null),
    installAppDir(),
    appVersion(),
  ).then(
    (swept) => {
      if (swept) saveJson(sweepFile, null)
    },
    () => appLog?.warn('install-sweep-failed'),
  )
  releaseChecks = registerReleaseCheck({
    openExternal: openExternalSafe,
    readSettings: readSettingsFile,
    log: appLog,
    version: appVersion(),
    method: installMethod,
    updateRunner,
    replaceAvailability: async () => {
      const dir = installAppDir()
      return dir ? canReplaceInstall(dir) : null
    },
    replacer: createInstallReplacer({
      appDir: installAppDir,
      base: releaseDownloadBase(app.isPackaged, process.env),
      fetch,
      tar: runTar,
      onState: announceReplace,
      onProgress: announceReplaceProgress,
      onReplaced: (pending) => saveJson(sweepFile, pending),
    }),
  })
  registerAgentTranscriptIpc()
  const notifyDeps = {
    execCommand,
    isScratchPane,
    windows: () => windows.values(),
    windowById: (id: string) => windows.get(id),
    redact: redactor.text,
  }
  registerNotifyMethods(notifyDeps)
  registerSandboxMethods({ domains: domainRequests, ports: portRequests })
  registerSecretMethods({
    service: secretService,
    sandboxes: workspaceSandboxes,
    ownerWindow: windowForWorkspace,
    vaultSet: setGlobalVaultValue,
    vaultDelete: deleteGlobalVaultValue,
  })
  if (process.platform === 'linux') setInterval(scanSandboxPorts, PORT_SCAN_MS).unref()
  onSandboxSpawnFailure = (workspaceId, errors) =>
    reportSandboxSpawnFailure(
      {
        notify: (input, onClick) =>
          postActionNotification(notifyDeps, { ...input, from: 'sandbox' }, onClick),
        showRequirements: (id, report) => {
          const windowId = windowForWorkspace(id)
          const win = windowId ? windows.get(windowId) : undefined
          if (!win || win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
          win.webContents.send('sandbox:blocked', { workspaceId: id, report })
        },
        report: () => {
          const missing = missingRequirements(SANDBOX_FEATURE)
          return {
            missing,
            hint: installHint(missing),
            canInstall: extensionHost?.list().some((x) => x.id === 'system' && x.enabled) ?? false,
          }
        },
      },
      workspaceId,
      errors,
    )
  registerNotifyIpc(notifyDeps)
  registerAttentionMethods({ execCommand, reported: (paneId) => keptAttention.reported(paneId) })
  registerAgentWorkMethods(agentWork)
  registerPaneRenameMethods({ execCommand, reach })
  registerPaneResumeMethods({
    execCommand,
    onResume: (identity, resume) => {
      telemetry?.count('agents', 'resume')
      paneWaking.end(identity.paneId, 'started')
      if (identity.manager) managerService?.rememberResume(resume)
    },
  })
  const registry = registerProcessMethods({
    openTab: openTerminalInWindow,
    onChange: (entry) => {
      syncKeptMeta(entry.paneId)
      paneWatch.emit(entry.paneId, { kind: 'state' })
    },
    ring: (paneId) => {
      const session = ptys.get(paneId)?.session
      return session ? (from) => session.since(from) : undefined
    },
    writePane: paneIo.write,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    endShell: (paneId) => killPty(paneId, 'process-kill'),
    hasShell: (paneId) => ptys.has(paneId),
    runInPane: (paneId, command) => {
      const windowId = getByPaneId(paneId)?.windowId
      const win = windowId ? windows.get(windowId) : undefined
      if (!win || win.isDestroyed()) return false
      win.webContents.send('pty:run', paneId, command)
      return true
    },
    cwdOfPane: (paneId) => terminalState.get(paneId)?.cwd,
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    reach,
    interruptGraceMs: INTERRUPT_GRACE_MS,
  })
  processes = registry
  const peekAttention = async (to: PaneIdentity): Promise<PaneAttentionPeek> => {
    const unreported = keptAttention.peek(to.paneId)
    if (unreported) return unreported
    const res = await execCommand(targetOf(to), 'attention.peek')
    return res.ok && res.result && typeof res.result === 'object' ? res.result : {}
  }
  const paneHibernated = async (to: PaneIdentity): Promise<boolean> => {
    const res = await execCommand(targetOf(to), 'pane.hibernated')
    return res.ok && (res.result as { hibernated?: unknown } | undefined)?.hibernated === true
  }
  const wakeHibernatedPane = async (to: PaneIdentity): Promise<boolean> => {
    const res = await execCommand(targetOf(to), 'pane.wake')
    return res.ok && (res.result as { woke?: unknown } | undefined)?.woke === true
  }
  const paneReachDeps: PaneReachDeps = {
    processPane: async (ref, ctx) => {
      const entry = registry.resolve(ref, ctx.identity.workspaceId, await reach.visible(ctx))
      return entry && entry.status !== 'closed' ? entry.paneId : undefined
    },
    inScope: reach.inScope,
    isChild: (ownerPaneId, paneId) => registry.isChild(ownerPaneId, paneId),
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isConfined: (paneId) => ptys.get(paneId)?.sandboxed === true,
  }
  registerPaneIoMethods({
    ...paneReachDeps,
    io: paneIo,
    state: getTerminalState,
    managerAllowsInput: () => managerSettings().allowInput,
    attention: peekAttention,
    inputSent: (to) => void execCommand(targetOf(to), 'attention.typed'),
    hibernated: paneHibernated,
    wake: wakeHibernatedPane,
    waking: paneWaking,
    close: (to) => execCommand(targetOf(to), 'pane.close'),
    resume: (to) => execCommand(targetOf(to), 'agent.resume'),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  registerPaneMoveToMethods({
    ...paneReachDeps,
    ownerWindow: windowForWorkspace,
    paneOf: getByPaneId,
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    ensureReach: reach.ensure,
    move: (to, workspaceId) => execCommand(targetOf(to), 'pane.moveToWorkspace', { workspaceId }),
  })
  registerPaneWaitMethods({
    ...paneReachDeps,
    watch: paneWatch,
    attention: peekAttention,
    exited: (paneId) => {
      const entry = registry.forPane(paneId)
      if (entry) return entry.status === 'exited'
      return terminalState.get(paneId)?.running === false
    },
  })
  registerDocsMethods({ extensions: () => extensionHost?.listForAgents() ?? [] })
  registerVaultMethods({ isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId) })
  registerOpenFileMethods({
    grants: openFileGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    confineFolder: (path) => resolveSafe(path, fileRoots()),
    waits: openWaits,
    execCommand,
  })
  registerBusMethods({
    inScope: reach.inScope,
    managerSendAllowed: () => managerLimiter?.busAllowed() ?? true,
    sent: () => telemetry?.count('agents', 'bus_message'),
    announce: (from, to, text) => {
      void announceBusMessage(
        {
          execCommand,
          listPanes: () =>
            listPanes({
              execCommand,
              getTerminalState,
              ptyPid,
              windowIds,
              waking: isWaking,
            }),
          listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
        },
        from,
        to,
        text,
      ).catch(() => {})
    },
    hibernated: paneHibernated,
  })
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  extensionHost = new ExtensionHost({
    onChanged: () => {
      languageServers?.refresh()
      refreshAgentPlugins()
    },
    onCrashed: (extId, builtin) =>
      telemetry?.error({
        source: 'extension-crashed',
        name: 'ExtensionCrashed',
        message: 'exited too often',
        ...(builtin || marketplaceInstallIds().includes(extId) ? { extension: extId } : {}),
      }),
    hostGrants: hostPaneGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    roots: extensionRoots(),
    store: extensionStore,
    socketPath: controlSocketPath,
    nodePath: process.execPath,
    dataDir: join(app.getPath('userData'), 'extension-data'),
    workDirForWorkspace,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    remoteCwdForPane: remoteCwdOfPane,
    remoteFolders: {
      windowOfWorkspace: workspaceWindowId,
      refusal: (workspaceId) =>
        scratchFolders.isScratch(workspaceId)
          ? 'scratch'
          : workspaceSandboxes.isEnabled(workspaceId)
            ? 'sandboxed'
            : null,
      confirm: (req) =>
        confirmRemoteFolder(windows.get(workspaceWindowId(req.workspaceId) ?? ''), {
          extName: req.extName,
          host: req.host,
          path: req.path,
        }),
      publish: publishRemoteFolders,
    },
    locale: readLocale,
    readExtensionSettings: () => readSettingsFile().extensionSettings,
    readAssistSettings: readSettingsFileOrNull,
    redact: redactor.redact,
    assistKeys: assistKeyStore(),
    secrets: extensionSecretStore(),
    openAssistUiIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'assist:open-ui', req),
    broadcast,
    publishWorkspaceChips,
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openFileIn: (req) =>
      openFileForExtension(
        { grants: openFileGrants, windowOf: workspaceWindowId, execCommand },
        req,
      ),
    openTerminalIn: openTerminalInWindow,
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    agentNames: () => Object.keys(managerAgents(managerSettings())),
    offerToAgentIn: (offer) => agentOffers.offer(offer),
    focusPaneIn: focusPaneInWindow,
  })
  refreshAgentPlugins()
  registerExtensionMethods(() => extensionHost)
  registerExtensionIpc(extensionHost)
  registerRemoteFilesIpc(extensionHost)
  ipcMain.on(AGENT_OFFER_RESULT_CHANNEL, (e, requestId: unknown, paneId: unknown) =>
    agentOffers.answer(String(e.sender.id), requestId, paneId),
  )
  languageServers = createLanguageServers()
  languageServers.refresh()
  registerLanguageServersIpc({
    servers: languageServers,
    setEnabled: (extId, serverId, enabled) =>
      extensionHost?.setLanguageServerEnabled(extId, serverId, enabled),
    setOverride: (key, override) => serverOverrides.choose(key, override),
  })
  const marketplace = new Marketplace({
    recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
    clonesDir: join(app.getPath('userData'), 'marketplaces'),
    extensionsDir: join(configDir(), 'extensions'),
    builtinIds: () =>
      extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    forget: (extId) => {
      managedServers.forgetExtension(extId)
      serverOverrides.forgetExtension(extId)
      extensionStore.delete(extId)
      for (const secrets of [extensionSecretStore(), assistKeyStore()]) {
        for (const key of secrets.keys(extId)) secrets.set(extId, key, null)
      }
    },
    rescan: () => extensionHost?.rescan(),
    locale: readLocale,
  })
  registerMarketplaceIpc(marketplace)
  marketplaceInstallIds = () =>
    marketplace
      .syncedInstalls()
      .filter((install) => marketplaceId(install.marketplace) === officialMarketplaceId)
      .map((install) => install.id)
  profileSync = startProfileSync({
    userData: app.getPath('userData'),
    configDir: configDir(),
    readSettings: readSettingsFile,
    broadcast: (channel, payload) => broadcast(channel, payload),
    onSettingsPulled: () => {
      extensionHost?.reloadSettings()
      extensionHost?.refreshLocale()
    },
    installedExtensions: () => marketplace.syncedInstalls(),
    builtinIds: () =>
      extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    installExtension: async (id, url) => (await marketplace.installSuggested(id, url, true)).ok,
    secretSources: () => {
      const store = (name: string) => {
        const path = storePath(name, 'global')
        return { deps: encryptedFile(path), mtime: () => statSync(path).mtimeMs }
      }
      const vault = store('vault')
      const ext = store('extension-secrets')
      const assist = store('assist-keys')
      const mcp = store('mcp-secrets')
      const logins = credentials()
      return [
        flatSource(vault.deps, vault.mtime),
        groupedSource('extensions', ext.deps, ext.mtime),
        groupedSource('assistant', assist.deps, assist.mtime),
        groupedSource('mcp', mcp.deps, mcp.mtime),
        ...(logins ? [loginsSource(logins)] : []),
      ]
    },
    protect: {
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (kept) => safeStorage.decryptString(Buffer.from(kept, 'base64')),
    },
    detectSecrets: (text) =>
      redactionScan.scan(text, parsePrivacySettings(readSettingsFile().privacy).redaction.patterns),
  })
  void profileSync.run()
  registerAssistIpc(() => extensionHost)
  registerChatSessionIpc(
    createChatSessionStore({ dir: join(dirname(storePath('chat', 'global')), 'chat-sessions') }),
    redactor.text,
  )
  const mcpSecretsPath = storePath('mcp-secrets', 'global')
  const mcpSecrets = encryptedStore(mcpSecretsPath)
  const chatToolSettings = () => parseChatToolSettings(readSettingsFile().assistant)
  mcpOAuth = new McpOAuth({
    store: createMcpOAuthStore(encryptedFile(mcpSecretsPath)),
    openExternal: openExternalSafe,
    browser: mcpOAuthBrowser(app.isPackaged, process.env),
    pages: () => mainStrings().native.signIn,
    onChange: () => mcpHost?.notify(),
  })
  mcpHost = new McpHost({
    servers: () => chatToolSettings().mcpServers,
    secret: (server, key) => mcpSecrets.get(server, key),
    onStatus: (status) => broadcast('chatTools:mcp-status', status),
    auth: mcpOAuth,
  })
  registerChatToolsIpc({
    roots: fileRoots,
    settings: chatToolSettings,
    mcp: mcpHost,
    secrets: mcpSecrets,
    oauth: mcpOAuth,
    grants: new ChatToolGrants(join(app.getPath('userData'), 'chat-tool-grants.json')),
    onGrants: (keys) => broadcast('chatTools:always-grants', keys),
  })
  const workflowDeps: WorkflowDeps = {
    userDir: join(configDir(), 'workflows'),
    roots: () => [homedir(), app.getPath('userData')],
    workDirForWorkspace,
    extensionWorkflows: () => extensionHost?.workflows() ?? [],
  }
  registerWorkflowIpc(workflowDeps)
  registerWorkflowMethods(workflowDeps)
  registerCompletionIpc({
    userDir: join(configDir(), 'completions'),
    extensionDirs: () => extensionHost?.completionDirs() ?? [],
  })
  viewHost = new ViewHost({
    dir: join(configDir(), 'views'),
    store: new ViewStore(join(app.getPath('userData'), 'views.json')),
    onChange: (listing) => broadcast('views:changed', listing),
    log: (line) => console.warn(`[views] ${line}`),
  })
  registerViewsIpc(viewHost)
  registerViewMethods({ host: viewHost, execCommand })
  registerIconThemeIpc({
    themes: () => extensionHost?.iconThemes() ?? [],
    onError: (id, error) => console.warn(`[icon theme ${id}] ${error}`),
  })
  registerKeymapIpc({
    keymaps: () => extensionHost?.keymaps() ?? [],
    platform: process.platform,
    onError: (ref, error) => console.warn(`[keymap ${ref}] ${error}`),
    onSkipped: (ref, skipped) =>
      console.warn(`[keymap ${ref}] skipped entries: ${describeSkipped(skipped)}`),
  })
  registerLanguagePackIpc(languagePackDeps)
  registerEditorLanguageIpc({
    languages: () => extensionHost?.editorLanguages() ?? [],
    onError: (extId, error) => console.warn(`[editor language ${extId}] ${error}`),
  })
  platformEvents.on('notify', (n: { title: string; body?: string; from: string }) =>
    extensionHost?.emitEvent('notification', n),
  )
  registerPaneListMethods({
    execCommand,
    getTerminalState,
    ptyPid,
    windowIds,
    waking: isWaking,
    reach,
  })
  registerGatewayMethods()
  const tailnet = createTailnet({
    command: tsnetHelperPath(app.getAppPath(), process.platform),
    stateDir: join(app.getPath('userData'), 'tsnet'),
    hostname: tailnetNodeName(hostname()),
    onChange: (state) => {
      onTailnetChange(state)
      broadcast('gateway:tailnet-changed', state)
    },
    log: (event, fields) => appLog?.info(event, fields),
  })
  configureTailnet(tailnet, { openExternal: (url) => void openExternalSafe(url) })
  stopTailnet = () => tailnet.stop()
  const publisher = createBonjourPublisher()
  configureAnnouncer(publisher)
  stopAnnouncing = publisher.unpublish
  onPairRequestsChanged(() => broadcast('gateway:pair-requests-changed', listPairRequests()))
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () =>
      listPanes({
        execCommand,
        getTerminalState,
        ptyPid,
        windowIds,
        waking: isWaking,
      }),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    fileScope: phoneFileScope,
    artifactsDir: (workspaceId) => artifactFolders.followed(workspaceId),
    openArtifact: async (workspaceId, path) => {
      const windowId = windowForWorkspace(workspaceId)
      if (!windowId) return false
      const res = await execCommand({ windowId, workspaceId, paneId: null }, OPEN_FILES_COMMAND, {
        files: [{ path }],
        background: true,
      })
      return res.ok
    },
    listWorkspaceGroups: () => listWorkspaceGroups({ execCommand, windowIds }),
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
    listAsks: askHub.list,
    answerAsk: askHub.answer,
    agentRunning: (paneId) => agentRunning.has(paneId) && ptys.has(paneId),
  })
  const sharedBrowser = session.fromPartition(SHARED_BROWSER_PARTITION)
  sharedBrowser.setUserAgent(browserUserAgent(sharedBrowser.getUserAgent(), app.getName()))
  const isSharedPane = (paneId: string): boolean => browserProfiles.isShared(paneId)
  registerBrowseMethods({
    allowNavigation: (workspaceId, url) => browserFence.check(workspaceId, url),
    browserPanes,
    isSharedPane,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
    reach,
  })
  registerPickMethods({ browserPanes, isSharedPane, errorBuffers, broadcast, reach })
  registerPickIpc(
    { browserPanes, isSharedPane, errorBuffers, broadcast, reach },
    reachesPane,
    redactor.text,
  )
  registerRegionIpc(browserPanes, reachesPane, redactor.text)
  registerBrowserStorageIpc((paneId, senderWindowId) =>
    ownedGuest(browserPanes, paneId, senderWindowId),
  )
  registerLoginFill({
    browserPanes,
    isSharedPane,
    ownedGuest: (paneId, senderWindowId) => ownedGuest(browserPanes, paneId, senderWindowId),
    reach,
  })
  const retiredTokens = retireLegacyScriptTokens(
    storePath('script-tokens', 'global'),
    retiredScriptTokensPath(),
  )
  if (retiredTokens.length > 0) {
    const text = mainStrings().native.scriptTokensRetired
    postNotification(notifyDeps, {
      title: fmt(text.title, { count: retiredTokens.length }),
      body: fmt(text.body, { names: retiredTokens.join(', ') }),
      from: 'script-tokens',
    })
  }
  registerScriptTokenMethods({
    path: scriptTokensPath,
    retiredPath: retiredScriptTokensPath,
    listing: workspaceListing,
  })
  setScriptTokenCheck((token) =>
    checkScriptToken({ path: scriptTokensPath(), retiredPath: retiredScriptTokensPath() }, token),
  )
  registerControlServer({
    execCommand,
    listCommandsFor,
    getTerminalState,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    windowOfWorkspace: workspaceWindowId,
    primaryWindow: primaryWindowId,
    byAgent: reach.byAgent,
    reach,
  })
  writeControlInfo(controlInfoPath(), controlSocketPath(), process.pid)
  if (keepShellsOn()) ensureKeptPlumbing()
  registerManagerIpc()
  managerLimiter = registerManagerMethods({
    settings: managerSettings,
    agents: () => managerAgents(managerSettings()),
    io: paneIo,
    openWorker,
    paneAlive: (paneId) => getByPaneId(paneId) !== undefined,
    now: Date.now,
  })
  managerService = new ManagerService({
    loadResume: () => loadJson<unknown>(managerResumePath(), null),
    saveResume: (saved) => {
      if (saved) saveJson(managerResumePath(), saved)
      else rmSync(managerResumePath(), { force: true })
    },
    agents: () => managerAgents(managerSettings()),
    createPane: createManagerPane,
    spawn: spawnManagerPty,
  })
  startPortal()
  appTray = new AppTray({
    iconPath: appIcon,
    tooltip: PRODUCT_DISPLAY_NAME,
    text: () => mainStrings().native.tray,
    windows: () => BrowserWindow.getAllWindows(),
    quit: requestQuit,
    setBadgeCount: (count) => app.setBadgeCount(count),
  })
  startCoreBoards()
  globalHotkey = new GlobalHotkey(globalShortcut, toggleAllWindows)
  applyGlobalHotkey()
  broker = new WindowBroker({
    createWindow,
    holdPtys,
    execCommand,
    agents: agentRunning,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    reveal: showWindow,
    onList: (list) => appTray?.setUnread(unreadWorkspaces(list)),
  })
  broker.register()
  broker.openAll()
  extensionHost.startEager()
  extensionHost.watchUserExtensions()
  viewHost.watch()
  app.on('browser-window-focus', emitFocusChanged)
  app.on('browser-window-blur', emitFocusChanged)
  setInterval(autosaveScrollback, SCROLLBACK_AUTOSAVE_MS).unref()

  app.on('activate', revealApp)
})

const redactionScan = createWorkerScan(redactionWorkerScript(app.getAppPath()))
const redactor = createRedactor(
  () => (readSettingsFile() as { privacy?: unknown }).privacy,
  redactionScan.scan,
)
const redactScrollback = createScrollbackRedactor(redactor)
let scrollbackSaves: Promise<void> = Promise.resolve()

function persistScrollback(): Promise<void> {
  if (broker && !broker.persisting) return scrollbackSaves
  let toSave: Record<string, string>
  try {
    const byPane = pendingRestoredScrollback()
    for (const [paneId, entry] of ptys) byPane[paneId] = entry.mirror.serialize()
    toSave = scrollbackToSave(byPane, isScratchPane)
  } catch (err) {
    console.error('[workspace] scrollback save failed', err)
    return scrollbackSaves
  }
  scrollbackSaves = scrollbackSaves
    .then(async () => {
      const redacted = await redactScrollback(toSave)
      if (savingScrollbackForQuit && !scrollbackSavedForQuit) quitTrace.stage('scrollback-redacted')
      if (broker && !broker.persisting) return
      await saveScrollback(redacted)
    })
    .catch((err: unknown) => console.error('[workspace] scrollback save failed', err))
  return scrollbackSaves
}

let scrollbackSavedForQuit = false
let savingScrollbackForQuit = false

const SCROLLBACK_AUTOSAVE_MS = 5000
let lastScrollbackSignature = ''

function autosaveScrollback(): void {
  let signature = ''
  for (const [paneId, entry] of ptys) signature += `${paneId}:${entry.mirror.revision};`
  signature += `pending:${Object.keys(pendingRestoredScrollback()).length}`
  if (signature === lastScrollbackSignature) return
  lastScrollbackSignature = signature
  void persistScrollback()
}

const quitTrace = createQuitTrace((event, fields) => appLog?.info(event, fields))

function exitAtQuitDeadline(): void {
  appLog?.warn('quit-deadline', {
    stage: quitTrace.current(),
    totalMs: quitTrace.elapsedMs(),
    alive: summarizeKinds(process.getActiveResourcesInfo()),
  })
  app.exit(0)
}

app.on('before-quit', (event) => {
  const plan = planQuit({
    approved: quitApproved,
    requestedByOstia: quitRequested,
    signaled: quitSignaled,
    platform: process.platform,
  })
  quitRequested = false
  quitTrace.stage(`plan-${plan}`)
  if (plan === 'unattended') {
    quitApproved = true
    freezeAll(BrowserWindow.getAllWindows())
    exitAfterDeadline(exitAtQuitDeadline)
  }
  if (plan === 'ask') {
    event.preventDefault()
    if (quitAsking) return
    quitAsking = true
    const all = BrowserWindow.getAllWindows()
    void confirmQuit(all, BrowserWindow.getFocusedWindow() ?? mainWindow(), {
      scratchFiles: (workspaceId) => scratchFolders.countFiles(workspaceId),
      kept: keptOnQuit(
        restartRequested,
        [...ptys.values()].map((entry) => ({ paneId: entry.paneId, kept: entry.kept !== null })),
      ),
      workspacesOf: (win) => broker?.workspacesOf(win) ?? [],
      processes: () =>
        [...ptys.values()].map((entry) => ({
          paneId: entry.paneId,
          workspaceId: entry.workspaceId,
          ...paneActivity(entry),
        })),
      confirmNative: (groups) => confirmQuitNatively(groups, mainStrings().native.quit),
    }).then((approved) => {
      quitAsking = false
      if (!approved) {
        restartRequested = false
        return
      }
      quitApproved = true
      freezeAll(all)
      app.quit()
    })
    return
  }
  if (!scrollbackSavedForQuit) {
    event.preventDefault()
    if (savingScrollbackForQuit) return
    savingScrollbackForQuit = true
    quitTrace.stage('scrollback')
    void persistScrollback().finally(() => {
      scrollbackSavedForQuit = true
      app.quit()
    })
    return
  }
  if (!telemetrySentForQuit) {
    event.preventDefault()
    if (sendingTelemetryForQuit) return
    sendingTelemetryForQuit = true
    quitTrace.stage('telemetry')
    void (telemetry?.shutdown() ?? Promise.resolve()).finally(() => {
      telemetrySentForQuit = true
      app.quit()
    })
    return
  }
  quitTrace.stage('teardown-windows')
  broker?.persist()
  managerService?.shutdown()
  appLog?.info('app-quit', { ptys: ptys.size })
  const keepingShells = restartRequested
  if (keepingShells) {
    for (const workspaceId of keptHostPanes.keys()) {
      syncKeptExposed(workspaceId, portForwarder.listeners(workspaceId))
    }
  }
  quitTrace.stage('teardown-ptys')
  for (const entry of ptys.values()) {
    entry.mirror.dispose()
    if (keepingShells && entry.kept) {
      entry.kept.detach()
      entry.portBridge?.close()
      continue
    }
    try {
      entry.pty.kill()
    } catch {}
    removeStateFile(entry)
  }
  ptys.clear()
  quitTrace.stage('teardown-kept-shells')
  if (keepingShells) keptShells.release()
  else keptShells.quitNow()
  quitTrace.stage('teardown-language-servers')
  languageServers?.stopAll()
  languageServerWatches.closeAll()
  quitTrace.stage('teardown-sandboxes')
  if (keepingShells) workspaceSandboxes.releaseAll()
  else workspaceSandboxes.stopAll()
  workspaceAgents.stopAll()
  for (const workspaceId of scratchFolders.workspaceIds()) workspaceSandboxes.forget(workspaceId)
  workspaceSandboxes.clearTmp(!keepingShells)
  artifactFolders.dispose()
  previews.dispose()
  scratchFolders.removeAll()
  quitTrace.stage('teardown-hosts')
  portForwarder.stopAll()
  gitService?.stop()
  portsService?.stop()
  extensionHost?.stopAll()
  mcpOAuth?.closeAll()
  mcpHost?.closeAll()
  viewHost?.stop()
  profileSync?.stop()
  quitTrace.stage('teardown-network')
  stopControlServer()
  clearControlInfo(controlInfoPath(), controlSocketPath())
  portal?.stop()
  void stopTailnet?.()
  stopAnnouncing?.()
  void stopGateway()
  appTray?.remove()
  globalHotkey?.clear()
  quitTrace.stage('teardown-done')
})

app.on('will-quit', () => quitTrace.stage('will-quit'))
app.on('quit', () => quitTrace.stage('quit'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') requestQuit()
})
