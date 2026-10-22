#!/usr/bin/env python3
"""Read-only installed-release packaging checks. Never builds, installs or opens the app."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--require-budget', action='store_true')
parser.add_argument('--require-managed-pilot', action='store_true')
parser.add_argument('--require-managed-startup', action='store_true')
parser.add_argument('--require-managed-paste', action='store_true')
parser.add_argument('--require-saved-restart', action='store_true')
parser.add_argument('--require-saved-recovery', action='store_true')
parser.add_argument('--require-preparation', action='store_true')
parser.add_argument('--require-preparation-release', action='store_true')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
sdk = Path(os.environ.get('ANDROID_SDK_ROOT', str(Path.home() / 'Library/Android/sdk')))
adb = str(sdk / 'platform-tools/adb')

def run(*command):
    return subprocess.check_output(command, text=True, stderr=subprocess.PIPE)

package = 'com.sleepercell.browser'
state = run(adb, '-s', args.device, 'shell', 'dumpsys', 'package', package)
version = re.search(r'versionName=(\S+)', state)
code = re.search(r'versionCode=(\d+)', state)
paths = run(adb, '-s', args.device, 'shell', 'pm', 'path', package).splitlines()
base = next((p.removeprefix('package:') for p in paths if p.endswith('/base.apk')), None)
if not version or not code or not base:
    raise SystemExit('Could not identify an installed Sleeper-Cell base APK')
with tempfile.TemporaryDirectory(prefix='managed-apk-preflight-') as directory:
    apk = Path(directory) / 'installed.apk'
    subprocess.run([adb, '-s', args.device, 'pull', base, str(apk)], check=True, capture_output=True)
    apk.chmod(0o600)
    with zipfile.ZipFile(apk) as archive:
        dex = b''.join(archive.read(name) for name in archive.namelist() if re.fullmatch(r'classes\d*\.dex', name))
        probe = archive.read('assets/website-ui-probe.js') if 'assets/website-ui-probe.js' in archive.namelist() else None
        budget = all(marker in dex for marker in [b'manager-relay-budget', b'pause_until'])
        pilot_markers = {
            'workflowCapability': b'chatgpt-default-crop/1' in dex,
            'defaultModelPrompt': b'managed-chatgpt-default-crop/1' in dex,
            'immutableUpload': b'/managed/artifacts' in dex,
            'durableActionGuard': b'External action already attempted' in dex,
            'explicitPhoneEntry': b'managed_pilot_nonce' in dex,
        }
        startup_markers = {
            'navigationGuard': b'The assigned ChatGPT tab navigated away; reconcile before continuing' in dex,
            'visibleTimeout': b'Timed out during:' in dex,
            'composerStage': b'Waiting for a fresh ChatGPT composer' in dex,
            'savedStatus': b'last_status_at' in dex,
        }
        paste_markers = {
            'inlineVerificationStage': b'Verifying the pasted crop prompt' in dex,
            'focusGuard': b'ChatGPT composer lost focus before text entry; no input was sent' in dex,
            'retainedComposerGuard': b'Composer changed before text entry; no input was sent' in dex,
            'convertedPromptGuard': b'ChatGPT converted the prompt to an attachment; exact prompt verification is unavailable. Reconcile without sending' in dex,
        }
        recovery_markers = {
            'explicitSavedOnlyControl': b'Upload retained saved result only' in dex,
            'savedRecoveryOperation': b'recover_saved' in dex,
            'savedRecoveryFence': b'Saved-only acknowledgment does not match retained attempt/checkpoint/lease' in dex,
            'separateRecoveryMode': b'recoveryOnly' in dex,
        }
        restart_markers = {
            'oneUseSetting': b'verify_saved_restart_once' in dex,
            'ownerControl': b'Pause next new managed run after saving (restart verification)' in dex,
            'savedBeforeAckMessage': b'Restart check: result saved locally; acknowledgment and upload held.' in dex,
            'savedOnlyResume': b'Saved output uploaded without regenerating.' in dex,
        }
        preparation_markers = {
            'durableQueue': b'library-page-preparation' in dex,
            'libraryControls': b'Process pending downloaded chapters' in dex,
            'verifiedReceipt': b'Preparation receipt is incomplete or pages changed' in dex,
            'managedSourceGuard': b'Managed task retains this chapter; reconcile its binding before preparation' in dex,
        }
        release_markers = {
            'chapterAction': b'Release cancelled task hold' in dex,
            'cancelledAuthorityRequired': b'Cancel the old task in Studio before releasing its source pages' in dex,
            'localStopReceiptRequired': b'Acknowledge the stop on this phone first' in dex,
            'releasedRevisionFence': b'This cancelled task released its source pages; plan a new input revision' in dex,
        }
    tools = sorted((sdk / 'build-tools').glob('*/apksigner'), key=lambda p: [int(n) if n.isdigit() else 0 for n in re.split(r'[.-]', p.parent.name)])
    cert = run(str(tools[-1]), 'verify', '--print-certs', str(apk))
    digest = re.search(r'certificate SHA-256 digest: (\w+)', cert)
    expected = '17281745ece33c5f810b50b67915960442e43e679bb3dcd49428448c4dccc874'
    result = {
        'checkedAt': datetime.now(timezone.utc).isoformat(), 'device': args.device, 'versionName': version.group(1), 'versionCode': int(code.group(1)),
        'releaseCertificateMatches': bool(digest and digest.group(1) == expected),
        'websiteUiProbePackaged': probe is not None,
        'probeSha256': hashlib.sha256(probe).hexdigest() if probe else None,
        'quotaBackoffMarkersPackaged': budget,
        'managedPilotPrerequisitesPackaged': all(pilot_markers.values()),
        'managedPilotMarkers': pilot_markers,
        'managedStartupPrerequisitesPackaged': all(startup_markers.values()),
        'managedStartupMarkers': startup_markers,
        'managedPastePrerequisitesPackaged': all(paste_markers.values()),
        'managedPasteMarkers': paste_markers,
        'savedRestartPrerequisitesPackaged': all(restart_markers.values()),
        'savedRestartMarkers': restart_markers,
        'savedRecoveryPrerequisitesPackaged': all(recovery_markers.values()),
        'savedRecoveryMarkers': recovery_markers,
        'preparationPrerequisitesPackaged': all(preparation_markers.values()),
        'preparationMarkers': preparation_markers,
        'preparationReleasePrerequisitesPackaged': all(release_markers.values()),
        'preparationReleaseMarkers': release_markers,
        'probeMatchesCurrentSource': probe == (Path(__file__).resolve().parent.parent / 'website-ui/probe.js').read_bytes(),
        'scope': 'Installed APK packaging only. Does not prove five-minute cadence, Retry-After persistence or managed execution behavior. No installation or app-data change.',
    }
print(json.dumps(result, indent=2))
if args.output:
    args.output.write_text(json.dumps(result, indent=2) + '\n')
if not result['releaseCertificateMatches'] or (args.require_budget and not budget) or (args.require_managed_pilot and not all(pilot_markers.values())) or (args.require_managed_startup and not all(startup_markers.values())) or (args.require_managed_paste and not all(paste_markers.values())) or (args.require_saved_recovery and not all(recovery_markers.values())) or (args.require_saved_restart and not all(restart_markers.values())) or (args.require_preparation and not all(preparation_markers.values())) or (args.require_preparation_release and not all(release_markers.values())):
    raise SystemExit(2)
