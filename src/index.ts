import * as OSC from 'osc-js';

// OSC server (port to listen to ZoomOSC and clients)
// Our Listener
const zoomInPort = process.env.LISTEN_PORT || 1234;

// Our sender (ZoomOSC listener)
const zoomOutHost = process.env.ZOOMOSC_HOST || 'localhost';
const zoomOutPort = process.env.ZOOMOSC_PORT || 9090;

const udpOptions = {
    open: {
        port: zoomInPort,
    },
    send: {
        port: zoomOutPort,
        host: zoomOutHost
    }
}

const osc = new OSC({
    discardLateMessages: false,
    plugin: new OSC.DatagramPlugin(udpOptions)
});

const USERROLE_NONE = 0;
const USERROLE_HOST = 1;
const USERROLE_COHOST = 2;
const LS_SUPPORT_GRP = "ls-support";      // Must assign a group called "ls-support"
const SKIP_PC = -1;
const SKIP_PC_STRING = "-";
const DEFAULT_MX_GRP = "leaders";

let primaryMode = true;
let myName = "";
let myZoomID: Number[] = [0, 0]

// The definition of the current state of the room
interface RoomState {
    // mapping names to their zoomIDs
    names: Map<string, number[]>;

    // custom groups of users
    groups: Map<string, number[]>;

    // everyone's state
    everyone: Map<number, PersonState>;
}

// What we keep track of for each person
interface PersonState {
    zoomID: number;
    userName: string;
    userRole: number;
    audioOn: boolean;
    videoOn: boolean;
}

// The ZoomOSC incoming user message with params broken out
interface ZoomOSCMessage {
    address: string;
    targetID: number;
    userName: string;
    galIndex: number;
    zoomID: number;
    params: string;
}

// The value of the room state
const state: RoomState = {
    names: new Map<string, number[]>(),
    groups: new Map<string, number[]>(),
    everyone: new Map<number, PersonState>()
}

// get this thing started
run()
    .then(() => {
        console.log(`running ...`);
    });

async function run() {

    // myName and primaryMode are need to support /xlocal commands

    // FIXME: Get myName from the command line until we find a way to figure it out from ZoomOSC
    if (process.argv[2]) {
        myName = process.argv[2];
    }
    if (process.argv[3]) {
        primaryMode = (process.argv[3] != "-secondary");
    }

    console.log(`running in ${ primaryMode ? "Primary" : "Secondary" } mode`);
    console.log(`running as user "${ myName }"`);

    // prepare to listen to OSC
    setupOscListeners();

    // start listening
    osc.open();
    console.log(`Listening to ${ osc.options.plugin.options.open.host }:${ osc.options.plugin.options.open.port }`);

    // tell ZoomOSC to listen to updates about the users
    sendToZoom('/zoom/subscribe', 2);

    // ask for snapshot of the users who were there first
    sendToZoom('/zoom/list');
}

function sendToZoom(message: string, ...args: any[]) {
    console.log("Sending to Zoom: %s, %s", message, args);
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}

/**
 * Take a raw messages and turn it into an element we can easily deal with later
 * @param message the raw message from ZoomOSC
 */
function parseZoomOSCMessage(message: any) {
    const [address, targetID, userName, galIndex, zoomID, params] = [message.address, message.args[0], message.args[1], message.args[2], message.args[3], message.args.slice(4)];

    return {
        address: address,
        targetID: Number(targetID),
        userName: userName,
        galIndex: Number(galIndex),
        zoomID: Number(zoomID),
        params: params
    }
}

/**
 * Received a chat messages. Do something with it. If it starts with '/', then do something with it
 * @param message the message received
 */

const HELPINFO = '\
/h | /help            \n\
/grp [options] <name> \n\
  [-l | -la | -d | -da]\n\
/list   : Update State \n\
/ma	    : Mute All     \n\
/mpin <group> : Multipin\n\
/mute <group>          \n\
/mx [grp]  : MA Except \n\
/names   : List Names  \n\
/pin <group>           \n\
/reset  : Reset State  \n\
/state  : Show State   \n\
/ua     : Unmute All   \n\
/umute <group>         \n\
';

function handleChatMessage(message: ZoomOSCMessage) {
    const chatMessage = message.params[0];
    if (chatMessage.charAt(0) !== '/') return;

    // clean the quotes before moving on
    cleanCurlyQuotes(chatMessage)

        // split each of the lines into an array item
        .split('\n')

        // skip the first one since we inserted a newline at the start
        .slice(1)

        // send each of the lines as separate commands
        .forEach(chatLine => {
            const subMessage: ZoomOSCMessage = { ...message, params: chatLine.trim() };
            handleChatCommand(subMessage);
        })
}

function handleChatCommand(message: ZoomOSCMessage) {
    const chatMessage = message.params;

    // FIXME:
    // set myZoomID
    // if (myZoomID[0] == 0) {
    //     myZoomID = state.names.get(myName);
    // }

    // only deal with chat messages starting with slash, else exit
    if (!chatMessage[0].startsWith('/')) {
        return;
    }

    // only deal with chat messages from a host, else exit
    // FIXME: Since we don't zoomID info for the users,for now, don't do isHost check for /xlocal commands
    const params = wordify(chatMessage);
    // if (!isHost(message.zoomID)) {
    if (!(params[0] == "/xlocal") && !isHost(message.zoomID)) {
        sendToZoom('/zoom/zoomID/chat', message.zoomID, "Error: Only Hosts and Co-hosts can issue Chat Commands");
        return;
    }

    // slash-command, do something with it
    // const params = wordify(chatMessage);
    console.log("args", params);

    // only /xlocal command is allowed on Secondary mode
    if (!primaryMode && !(params[0] == "/xlocal")) {
        return;
    }

    switch (params[0]) {
        case '/mx':  // mute all except members of group - No option => use LS_SUPPORT_GRP
            muteAllExceptGroup(message, params);
            break;
        case '/ua': // unmute all
            sendToZoom('/zoom/all/unMute');
            break;
        case '/ma': // mute all
            sendToZoom('/zoom/all/mute');
            break;
        case '/m':  // mute group
        case '/mute':
            muteGroup(message, params);
            break;
        case '/u':  // unmute group
        case '/unmute':
            unmuteGroup(message, params);
            break;
        case '/g':
        case '/grp':
        case '/grps':
        case '/group': // create or list groups
            manageGroups(message.zoomID, params);
            break;
        case '/p':
        case '/pin': // pin to second monitors (Must have a group called "ls-support")
            setPin(message.zoomID, params);
            break;
        case '/mp':
        case '/mpin':     // multipin to monitor (Must have a group called "ls-support")
        case '/multipin': // Can only multipin to a device running ZoomOSC PRO
            setMultiPin(message.zoomID, params);
            break;
        case '/names':    // Display the current list of users
            displayAllNames(message.zoomID);
            break;
        case '/list':     // initiate a /list command
            sendToZoom('/zoom/list');
            break;
        case '/state':   // Display full state on console
            console.log("handleChatMessage state");
            console.log(`  myName: ${ myName }`);
            console.log(`  myZoomID: ${ myZoomID }`);
            console.log(`state:`, state);
            break;
        case '/h':
        case '/help':
            sendToZoom('/zoom/zoomID/chat', message.zoomID, HELPINFO);
            break;
        case '/xremote':
            executeRemote(message, params);
            break;
        case '/xlocal':
            executeLocal(message, params);
            break;
        case '/reset':    // Clear state and build new state
            state.names.clear();
            state.groups.clear();
            state.everyone.clear();
            sendToZoom('/zoom/list');
            break;
        case '/test':
            // console.log("quicktest: /zoom/clearPin");
            // sendToZoom("/zoom/clearPin");
            break;
        default:
            console.log("handleChatMessage Error: Unimplemented Chat Command");
            sendToZoom('/zoom/zoomID/chat', message.zoomID, "Error: Unimplemented Chat Command");
    }
}

function isHost(zoomid: number): boolean {
    const person = state.everyone.get(zoomid);
    if (!person) return undefined;
    // console.log("handleisHost person", person);
    return (person.userRole == USERROLE_HOST) || (person.userRole == USERROLE_COHOST);
}

function getPeopleFromName(name: string): PersonState[] {
    const ids = state.names.get(name);
    if (!ids) return undefined;
    // return all the people with that name
    return ids.map(id => state.everyone.get(id));
}

function createGroup(recipientZoomID: number, params: string[]) {
    let zoomidList: number[] = [];

    const namesList = params.slice(2);

    namesList.forEach((name) => {
        const curUser: PersonState[] = getPeopleFromName(name);
        if (!curUser) {
            if (name === SKIP_PC_STRING) {
                zoomidList.push(SKIP_PC);
            } else {
                console.log(`createGroup: Error - User "${ name }" does not exist`);
                sendToZoom('/zoom/zoomID/chat', recipientZoomID, `createGroup: Error - User "${ name }" does not exist`);
            }
        } else {
            zoomidList.push(...curUser.map(user => user.zoomID));
        }
    });

    state.groups.set(params[1], zoomidList);
}

function deleteGroup(recipientZoomID: number, param: string) {
    const members = state.groups.get(param);

    if (!members) {
        console.log(`deleteGroup Error: Group "${ param }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `displayGroup Error: Group "${ param }" does not exist`);
        return;
    }

    state.groups.delete(param);
}

function displayGroup(recipientZoomID: number, param: string) {
    const members = state.groups.get(param);

    if (!members) {
        console.log(`displayGroup Error: Group "${ param }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `displayGroup Error: Group "${ param }" does not exist`);
        return;
    }

    let buffer = "/grp " + param;
    members.forEach((zoomid) => {
        if (zoomid == SKIP_PC) {
            buffer = buffer.concat(" " + SKIP_PC_STRING);
        } else {
            const person = state.everyone.get(zoomid);
            const name = person.userName;
            buffer = buffer.concat(" \"" + name + "\"");
        }
    });

    console.log("displayGroup :", buffer);
    sendToZoom('/zoom/zoomID/chat', recipientZoomID, buffer);
}


function displayAllGroups(recipientZoomID: number) {
    state.groups
        .forEach((memberZoomIDs, groupName) => {
            displayGroup(recipientZoomID, groupName);
        })
}

function displayName(recipientZoomID: number, param: string) {
    const members = state.names.get(param);

    if (!members) {
        console.log(`displayName Error: Name "${ param }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `displayName Error: Group "${ param }" does not exist`);
        return;
    }

    let buffer = "";
    members.forEach((zoomid) => {
        const person = state.everyone.get(zoomid);
        const name = person.userName;
        buffer = buffer.concat("\"" + name + "\"\n");
    });

    console.log("displayName :", buffer);
    sendToZoom('/zoom/zoomID/chat', recipientZoomID, buffer);
}

function displayAllNames(recipientZoomID: number) {
    state.names
        .forEach((memberZoomIDs, Name) => {
            displayName(recipientZoomID, Name);
        })
}

function manageGroups(recipientZoomID: number, params: string[]) {

    // Usage:  /grp [(-l |-list) | (-la -listall) | (-d | -delete) | (-da | -deleteall] <groupname>
    //         /grp <groupname> [<group members>]

    // Sub commands
    if (params[1].startsWith('-')) {
        switch (params[1]) {
            case '-l':
            case '-list':
                if (params[2]) {
                    displayGroup(recipientZoomID, params[2]);
                }
                break;
            case '-la':
            case '-listall':
                displayAllGroups(recipientZoomID);
                break;
            case '-d':
            case '-delete':
                if (params[2]) {
                    deleteGroup(recipientZoomID, params[2]);
                }
                break;
            case '-da':
            case '-deleteall':
                state.groups.clear();
                break;
            default:
                console.log("manageGroups Error: Unimplemented Groups Sub-Command");
                sendToZoom('/zoom/zoomID/chat', recipientZoomID, "Error: Unimplemented Groups Sub-Command");
        }
        return;
    }

    if (params.length > 2) {
        createGroup(recipientZoomID, params);
    } else {
        displayGroup(recipientZoomID, params[1]);
    }
}

function setPin(recipientZoomID: number, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);

    // Make sure LS-SUPPORT group exists
    if (!supportPCs) {
        console.log(`setPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }

    // Make sure group exists
    if (!currentGroup) {
        console.log(`setPin Error: Group "${ params[1] }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setPin Error: Group "${ params[1] }" does not exist`);
        return;
    }

    let pos = -1;
    currentGroup.forEach(function (zoomid) {
        pos++;
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const name = person.userName;
        const targetPC = state.everyone.get(supportPCs[pos]);
        if (targetPC.zoomID == SKIP_PC) return;

        if (!person) {
            console.log(`setPin: Error - User "${ person.zoomID }" does not exist`);
            sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            // Check if I'm the target
            if (targetPC.userName == myName) {
                console.log(`setPin: /zoom/userName/pin2, ${ name }`);
                sendToZoom("/zoom/userName/pin2", name);
            } else {
                // FIXME: Prefer to use zoomID instead of userName, but zoomID state not maintained (yet) in secondary mode
                //sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${targetPC.zoomID} /zoom/zoomID/pin2 ${zoomid}`);
                console.log('setPin: /zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/userName/pin2 "${ name }"`);
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/userName/pin2 "${ name }"`);
            }
        }
    });
}

function setMultiPin(recipientZoomID: number, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);

    // FIXME: Need to implement default multipin device - Use primary device for now.
    //        This could/should change when there are more than one activations
    const multipinDevice = myName;

    // Make sure device exists
    const device = getPeopleFromName(multipinDevice);
    if (!device) {
        console.log(`setMultiPin Error: User "${ multipinDevice }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setMultiPin Error: User "${ multipinDevice }" does not exist`);
        return;
    }
    // Make sure LS-SUPPORT group exists
    if (!supportPCs) {
        console.log(`setMultiPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setMultiPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }
    // Make sure device is in LS-SUPPORT group
    const gotit = supportPCs.filter(id => id == device[0].zoomID);
    if (gotit.length == 0) {
        console.log(`setMultiPin Error: Device: "${ multipinDevice }" is not included in Group: "${ LS_SUPPORT_GRP }"`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID,
            `setMultiPin Error: Device: "${ multipinDevice }" is not included in Group: "${ LS_SUPPORT_GRP }"`);
        return;
    }
    // Make sure Multipin group exists
    if (!currentGroup) {
        console.log(`setMultiPin Error: Group "${ params[1] }" does not exist`);
        sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setMultiPin Error: Group "${ params[1] }" does not exist`);
        return;
    }

    const targetPC = state.everyone.get(device[0].zoomID);

    // Clear all Pins before adding new group
    if (targetPC.userName == myName) {
        console.log("setMultiPin: /zoom/me/clearPin");
        sendToZoom("/zoom/me/clearPin");
    } else {
        console.log('setMultiPin: /zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/me/clearPin`);
        sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/me/clearPin`);
    }

    currentGroup.forEach(function (zoomid) {
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const name = person.userName;

        if (!person) {
            console.log(`setMultiPin: Error - User "${ person.zoomID }" does not exist`);
            sendToZoom('/zoom/zoomID/chat', recipientZoomID, `setMultiPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            if (targetPC.userName == myName) {
                console.log(`setMultiPin: /zoom/userName/addPin, ${ name }`);
                sendToZoom("/zoom/userName/addPin", name);
            } else {
                // FIXME: Prefer to use zoomID instead of userName, but zoomID state not maintained (yet) in secondary mode
                //        Also, not sure if addPin works with a list of zoomID's
                console.log('setMultiPin: /zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${ targetPC.userName } /zoom/userName/addPin "${ name }"`);
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${ targetPC.userName } /zoom/userName/addPin "${ name }"`);
            }
        }
    });
}

function muteAllExceptGroup(message: ZoomOSCMessage, params: string[]) {

    let group: string;

    if (!params[1]) {
        group = DEFAULT_MX_GRP;
    } else {
        group = params[1];
    }

    if (!state.groups.get(group)) {
        // no group available, mute everyone
        sendToZoom('/zoom/all/mute');
        return;
    }

    // Unmute the leaders then mute everyone else
    sendToZoom('/zoom/users/zoomID/unMute', ...state.groups.get(group));
    sendToZoom('/zoom/allExcept/zoomID/mute', ...state.groups.get(group));
}

function unmuteGroup(message: ZoomOSCMessage, params: string[]) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup) return;

    sendToZoom('/zoom/users/zoomID/unMute', ...state.groups.get(params[1]));
    // displayGroup(message.zoomID, params[1]);
}

function muteGroup(message: ZoomOSCMessage, params: string[]) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup) return;

    sendToZoom('/zoom/users/zoomID/mute', ...state.groups.get(params[1]));
    // displayGroup(message.zoomID, params[1]);
}

function executeRemote(message: ZoomOSCMessage, params: string[]) {
    const curUser: PersonState[] = getPeopleFromName(params[1]);
    if (!curUser) return;

    console.log(`executeRemote`);

    // FIXME: using the zoomID isn't working - use userName for now
    // sendToZoom('/zoom/zoomID/chat', curUser.map(user => user.zoomID), "/xlocal ", ...params.slice(2));
    sendToZoom('/zoom/userName/chat', curUser.map(user => user.userName), "/xlocal ", ...params.slice(2));
}

function executeLocal(message: ZoomOSCMessage, params: string[]) {
    // no zoom ids found, return
    // if (myZoomID) {
    // }

    // Command format: /xlocal targetPC.zoomID <ZoomOSC Command> [options]`);
    console.log(`executeLocal myName = "${ myName }"`, params);
    // Make sure this is the targetPC
    // if (Number(params[1]) == myZoomID[0]) {        -- FIXME: Having troubles with using the zoomid
    if (params[1] == myName) {
        // FIXME: Not sure why this doesn't compile - Probably because the result of the slice could be null
        // sendToZoom(...params.slice(2));
        sendToZoom(params[2], ...params.slice(3));
    }
}

// This changes curly quotes and strange line-endings to plain ascii versions
function cleanCurlyQuotes(str: string): string {
    return str &&
        String(str)
            .replace(/[\u2028]/g, "\n")
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/[\u201C\u201D]/g, '"');
}

// This combines quotes strings into a single "word"
function wordify(str: string): string[] {
    // combine words in quotes to be a single param. eg: param1 "second param" 'third param'
    return str &&
        (String(str).match(/[^\s"]+|"([^"]*)"/gi) || [])
            .map((word) => word.replace(/^"(.+(?="$))"$/, '$1'));
}

function handleUnmute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.audioOn = true;
    // console.log("handleUnmute message, person", message, person);
}

function handleMute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.audioOn = false;
    // console.log("handleMute message, person", message, person);
}

function handleVideoOn(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.videoOn = true;
    // console.log("handleVideoOn message, person", message, person);
}

function handleVideoOff(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.videoOn = false;
    // console.log("handleVideoOff message, person", message, person);
}

function handleRoleChanged(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;
    person.userRole = Number(message.params[0]);
    // console.log("handleRoleChanged message, person", message, person);
}

function addZoomIDToName(name: string, zoomID: number) {
    const zoomIDs: number[] = state.names.get(name);
    if (!zoomIDs) {
        state.names.set(name, [zoomID]);
        return;
    }

    // if it's already there, we're done
    if (zoomIDs.includes(zoomID)) return;

    state.names.set(name, [...zoomIDs, zoomID]);
}

function removeZoomIDFromName(name: string, zoomID: number) {
    const zoomIDs: number[] = state.names.get(name);
    // no zoom ids found, return
    if (!zoomIDs) return;

    // example of how to call a function inside a filter
    const newZoomIDs = zoomIDs.filter((id) => {
        console.log(`does ${ id } == ${ zoomID }?`)
        return id !== zoomID;
    });
    // shortcut
    //const newZoomIDs = zoomIDs.filter(id => id !== zoomID);
    if (newZoomIDs.length === 0) {
        // nothing left, remove the whole thing
        state.names.delete(name);
        return;
    }

    state.names.set(name, newZoomIDs);
}

function handleNameChanged(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    if (!person) return;

    // update the names table
    removeZoomIDFromName(person.userName, message.zoomID);
    addZoomIDToName(message.userName, message.zoomID);
    console.log(`handleuserNameChanged zoomID: ${ message.zoomID }, oldName: ${ person.userName }, newName: ${ message.userName }`);

    person.userName = message.userName;

    // Check if myName needs to be updated
    if (message.zoomID == myZoomID[0]) {
        myName = message.userName;
    }
}

let lastJoinTime: number = 0;

function handleOnline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

    // FIXME: ZoomOSC is not issuing a /list after a member joins.
    //        Workaround this for now by sending a /list command after first join or if 30 sec passed since last member joined
    let currentTime = Date.now();
    if (!lastJoinTime || ((currentTime - lastJoinTime) > 30000)) {
        console.log(`handleOnline Workaround: lastJoinTime = ${ lastJoinTime }, currentTime = ${ currentTime }`);
        sendToZoom('/zoom/list');
    }
    lastJoinTime = currentTime;

    if (person) return;

    person = {
        zoomID: message.zoomID,
        userName: message.userName,
        userRole: USERROLE_NONE,
        audioOn: false,
        videoOn: false
    }
    state.everyone.set(person.zoomID, person);
    addZoomIDToName(message.userName, message.zoomID);
    console.log("handleOnline message, person", message, person);
}

// FIXME: ZoomOSC is not issuing the offline command yet
function handleOffline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

    if (person) return;

    console.log("handleOffline message, person", message, person);
    state.everyone.delete(person.zoomID);
    removeZoomIDFromName(message.userName, message.zoomID);

}

function handleList(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);
    if (!person) {
        person = {
            zoomID: message.zoomID,
            userName: message.userName,
            userRole: Number(message.params[2]),
            audioOn: Boolean(message.params[5]),
            videoOn: Boolean(message.params[4])
        }
        state.everyone.set(person.zoomID, person);
    } else {
        person.userName = message.userName;
        person.userRole = Number(message.params[2]);
        person.audioOn = Boolean(message.params[5]);
        person.videoOn = Boolean(message.params[4]);
    }
    addZoomIDToName(message.userName, message.zoomID);
}

function handleMeetingStatus(_message: ZoomOSCMessage) {
    state.names.clear();
    state.groups.clear();
    state.everyone.clear();
}

function setupOscListeners() {

    // convenient code to print every incoming messagse
    // osc.on('*', message => {
    //     console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/meetingStatus', async message => handleMeetingStatus(parseZoomOSCMessage(message)));

    osc.on('/zoomosc/user/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/offline', async message => handleOffline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));

    osc.on('/zoomosc/me/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/offline', async message => handleOffline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/list', async message => handleList(parseZoomOSCMessage(message)));
}

// not used right now, but could be used to pause between things
// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
