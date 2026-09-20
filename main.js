// main.js
// 
// npx electron-packager . windows --platform=win32 --arch=x64 --icon=assets/images/icon.ico
// npx electron-packager . WindowsApp --override --platform=linux --arch=x64 --icon=assets/images/icon.ico --prune=true --out=release-builds
// npm run deb64
// 
//const { createAuthWindow, createLogoutWindow } = require('./main/auth-process');
const { app, screen, components, BrowserWindow, dialog, Notification, ipcRenderer, globalShortcut, crashReporter} = require('electron');
console.log(`Electron version: ${app.getVersion()}`);

// You have to pass the directory that contains widevine library here, it is
// * `libwidevinecdm.dylib` on macOS,
// * `widevinecdm.dll` on Windows.
//app.commandLine.appendSwitch('widevine-cdm-path', 'C:\Program Files\Google\Chrome\Application\112.0.5615.138\WidevineCdm\_platform_specific\win_x64\widevinecdm.dll')
// The version of plugin can be got from `chrome://components` page in Chrome.
//app.commandLine.appendSwitch('widevine-cdm-version', '1.0.2512.0')

const envVariables = require('./env-variables');

const { exec } = require('child_process');
const {apiIdentifier, base_url, clientId, isDev} = envVariables;

const app_process = require('./main/app-process');
const NOTIFICATION_TITLE = 'Basic Notification'
const NOTIFICATION_BODY = 'Notification from the Main process'

function showNotification() {
    new Notification({title: NOTIFICATION_TITLE, body: NOTIFICATION_BODY}).show()
}

app.disableHardwareAcceleration();

app.commandLine.appendSwitch('disable-pinch');
//app.whenReady().then(function () {
app.on('ready', async function () {
    //try {
    //    await components.whenReady();
    //    //console.log('components ready:', components.status());
    //} catch (e) {
        await app.whenReady();
    //    console.log(e);
    //}
    
    app_process.createAppWindow();

//    dialog.showMessageBox({
//        // option Object
//        type: 'none',
//        buttons: [],
//        defaultId: 0,
//        icon: '',
//        title: 'Windows Alert',
//        message: 'Do you want to logout from the application',
//        detail: 'This is extra Information',
//        checkboxLabel: 'Checkbox',
//        checkboxChecked: false,
//        cancelId: 0,
//        noLink: false,
//        normalizeAccessKeys: false,
//    }).then(box => {
//        console.log('Button Clicked Index - ', box.response);
//        console.log('Checkbox Checked - ', box.checkboxChecked);
//    }).catch(err => {
//        console.log(err)
//    });

    if (envVariables.isDev === 0) {
        globalShortcut.register('F11', () => {  // creates a global shortcut
            console.log('gobal shortcut presses F11');      // action when shortcut is pressed
        });
        globalShortcut.register('Ctrl+0', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Ctrl+0');      // action when shortcut is pressed
        });
        globalShortcut.register('Ctrl+Shift+Plus', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Ctrl+Shift+Plus');      // action when shortcut is pressed
        });
        globalShortcut.register('Ctrl+r', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Ctrl+R');      // action when shortcut is pressed
        });
        globalShortcut.register('Ctrl+Shift+r', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Ctrl+Shift+R');      // action when shortcut is pressed
        });
        globalShortcut.register('Ctrl+-', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Ctrl+-');      // action when shortcut is pressed
        });
        globalShortcut.register('alt+tab', () => {  // creates a global shortcut
            console.log('gobal shortcut presses Alt+Tab');      // action when shortcut is pressed
        });
        globalShortcut.register('Escape', () => {
            app.quit();
        });
    }
});
//app.whenReady().then(app_process.createAppWindow()).then(showNotification)

//app.setUserTasks([]);


// Quit when all windows are closed.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    let timer = app_process.progressTimer();
    if (timer !== null) {
        clearInterval(timer);
    }
});

function screen_checking() {
    const displays = screen.getAllDisplays();
    const externalDisplay = displays.find((display) => {
        return display.bounds.x !== 0 || display.bounds.y !== 0;
    });
    console.log(externalDisplay);
    if (displays !== undefined) {
        if (displays.length > 1) {
            app.quit();
        } else {
            if (displays[0].size.width > 1920) {
                app.quit();
            }
        }
    }
}





// Function to get all process IDs on Windows
function getAllProcesses(callback) {
    exec('tasklist /FO CSV /NH', (error, stdout, stderr) => {
        if (error) {
            callback(error);
            return;
        }

        const processList = stdout.split('\r\n').slice(0, -1);
        const processes = processList.map((line) => {
            const [image, pid, ...rest] = line.split('","');
            return {
                name: image.replace(/"/g, ''),
                pid: parseInt(pid, 10),
            };
        });

        callback(null, processes);
    });
}
function check_and_kill() {
    getAllProcesses((error, processIds) => {
        if (error) {
            console.error(`Error: ${error.message}`);
            return;
        }

        var kill_apps = ['fiddler', 'wireshark', 'burp', 'anydesk', 'teamviewer', 'teams', 'screenrec'];

        processIds.forEach(function (process) {
            kill_apps.forEach(function (killable) {
                if (process.name.toLowerCase().includes(killable)) {
                    exec(`taskkill /F /PID ${process.pid}`, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Error: ${error.message}`);
                        } else {
                            console.log(`Process with PID ${process.pid} has been terminated.`);
                        }
                    });
                }
            })
            //console.log(process);
        });
        //console.log('All Process IDs:', processIds);
    });
}

setInterval(function() {
    check_and_kill();
}, 5000);

app.whenReady().then(() => {
    screen_checking();
    check_and_kill();
    screen.on('display-added', function () {
        screen_checking();
    });

});
