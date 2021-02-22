"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const OSC = require("osc-js");
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
};
const osc = new OSC({
    discardLateMessages: false,
    plugin: new OSC.DatagramPlugin(udpOptions)
});
const USERROLE_NONE = 0;
const USERROLE_HOST = 1;
const USERROLE_COHOST = 2;
const LS_SUPPORT_GRP = "ls-support"; // Must assign a group called "ls-support"
const SKIP_PC = -1;
const SKIP_PC_STRING = "-";
const DEFAULT_MX_GRP = "leaders";
let primaryMode = true;
let myName = "";
let myZoomID = [0, 0];
// The value of the room state
const state = {
    names: new Map(),
    groups: new Map(),
    everyone: new Map()
};
// get this thing started
run()
    .then(() => {
    // myName and primaryMode are need to support /xlocal commands
    // NOTE: Get myName from the command line until we find a way to figure it out from ZoomOSC
    if (process.argv[2]) {
        myName = process.argv[2];
    }
    if (process.argv[3]) {
        primaryMode = (process.argv[3] != "-secondary");
    }
    console.log(`running in ${primaryMode ? "Primary" : "Secondary"} mode`);
    console.log(`running as user "${myName}"`);
});
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        // prepare to listen to OSC
        setupOscListeners();
        // start listening
        osc.open();
        console.log(`Listening to ${osc.options.plugin.options.open.host}:${osc.options.plugin.options.open.port}`);
        // tell ZoomOSC to listen to updates about the users
        sendToZoom('/zoom/subscribe', 2);
        // ask for snapshot of the users who were there first
        sendToZoom('/zoom/list');
    });
}
function sendToZoom(message, ...args) {
    console.log("Sending to Zoom: %s, %s", message, args);
    try {
        osc.send(new OSC.Message(message, ...args));
    }
    catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}
/**
 * Take a raw messages and turn it into an element we can easily deal with later
 * @param message the raw message from ZoomOSC
 */
function parseZoomOSCMessage(message) {
    const [address, targetID, userName, galIndex, zoomID, params] = [message.address, message.args[0], message.args[1], message.args[2], message.args[3], message.args.slice(4)];
    return {
        address: address,
        targetID: Number(targetID),
        userName: userName,
        galIndex: Number(galIndex),
        zoomID: Number(zoomID),
        params: params
    };
}
/**
 * Received a chat messages. Do something with it. If it starts with '/', then do something with it
 * @param message the message received
 */
const HELPINFO = '\
/h | /help	: Print this message   \n\
/ma		 : Mute all users          \n\
/mx	[grp]: Mute all but group      \n\
/ua		 : Unmute all users';
function handleChatMessage(message) {
    const chatMessage = message.params;
    // set myZoomID
    if (myZoomID[0] == 0) {
        myZoomID = state.names.get(myName);
    }
    // only deal with chat messages starting with slash, else exit
    if (!chatMessage[0].startsWith('/')) {
        return;
    }
    // only deal with chat messages from a host, else exit
    if (!isHost(message.zoomID)) {
        sendToZoom('/zoom/zoomID/chat', message.zoomID, "Error: Only Hosts and Co-hosts can issue Chat Commands");
        return;
    }
    // slash-command, do something with it
    const params = parseChatParams(chatMessage);
    console.log("args", params);
    // only /xlocal command is allowed on Secondary mode
    if (!primaryMode && !(params[0] == "/xlocal")) {
        return;
    }
    switch (params[0]) {
        case '/mx': // mute all except but members of group - No option => use LS_SUPPORT_GRP
            muteAllExceptGroup(message, params);
            break;
        case '/ua': // unmute all
            sendToZoom('/zoom/all/unMute');
            break;
        case '/ma': // mute all
            sendToZoom('/zoom/all/mute');
            break;
        case '/m': // mute group
        case '/mute':
            muteGroup(message, params);
            break;
        case '/u': // unmute group
        case '/unmute':
            unmuteGroup(message, params);
            break;
        case '/g':
        case '/grp':
        case '/group': // create or list groups
            manageGroups(message, params);
            break;
        case '/p':
        case '/pin': // pin to second monitors (Must have a group called "ls-support")
            setPin(message, params);
            break;
        case '/mp':
        case '/mpin':
        case '/multipin': // multipin to monitors (Must have a group called "ls-support")
            setMultiPin(message, params);
            break;
        case '/list': // list all users
            sendToZoom('/zoom/list');
            break;
        case '/state':
            console.log("handleChatMessage state");
            console.log(`  myName: ${myName}`);
            console.log(`  myZoomID: ${myZoomID}`);
            console.log(`state:`, state);
            break;
        case '/test':
            console.log("handleChatMessage /test", params[1], params[2]);
            sendToZoom('/zoom/userName/remoteAddPin', params[1], params[2]);
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
        default:
            console.log("handleChatMessage Error: Unimplemented Chat Command");
            sendToZoom('/zoom/zoomID/chat', message.zoomID, "Error: Unimplemented Chat Command");
    }
}
function isHost(zoomid) {
    const person = state.everyone.get(zoomid);
    if (!person)
        return undefined;
    // console.log("handleisHost person", person);
    return (person.userRole == USERROLE_HOST) || (person.userRole == USERROLE_COHOST);
}
function getPeopleFromName(name) {
    const ids = state.names.get(name);
    if (!ids)
        return undefined;
    // return all the people with that name
    return ids.map(id => state.everyone.get(id));
}
function createGroup(params) {
    let zoomidList = [];
    const namesList = params.slice(2);
    namesList.forEach((name) => {
        const curUser = getPeopleFromName(name);
        if (!curUser) {
            if (name === SKIP_PC_STRING) {
                zoomidList.push(SKIP_PC);
            }
            else {
                console.log(`createGroup: Error - User "${name}" does not exist`);
            }
        }
        else {
            zoomidList.push(...curUser.map(user => user.zoomID));
        }
    });
    state.groups.set(params[1], zoomidList);
}
function displayGroup(zoomid, param) {
    if (!state.groups.get(param))
        return;
    console.log("displayGroup", zoomid, state.groups.get(param));
    //sendToZoom('/zoom/zoomID/chat', zoomid, buffer);
}
function manageGroups(message, params) {
    console.log("manageGroups: 1", params, params.length);
    if (params.length > 2) {
        createGroup(params);
    }
    displayGroup(message.zoomID, params[1]);
}
function setPin(message, params) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);
    let pos = -1;
    currentGroup.forEach(function (zoomid) {
        pos++;
        if (zoomid == SKIP_PC)
            return;
        const person = state.everyone.get(zoomid);
        const name = person.userName;
        const targetPC = state.everyone.get(supportPCs[pos]);
        if (!person) {
            console.log(`setPin: Error - User "${person.zoomID}" does not exist`);
        }
        else {
            //sendToZoom('/zoom/userName/remotePin2', targetPC.userName, name);
            //sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${targetPC.zoomID} /zoom/zoomID/pin2 ${zoomid}`);
            console.log('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${targetPC.zoomID} /zoom/userName/pin2 "${name}"`);
            sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal ${targetPC.zoomID} /zoom/userName/pin2 "${name}"`);
        }
    });
}
function setMultiPin(message, params) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[2]);
    // This is a work in progress - Turns out that ZoomOSC doesn't support /users for remoteAddPin ( also a PRO feature )
    console.log(`setMultiPin: params ${params}, currentGroup ${currentGroup}`);
    const newGroup = currentGroup.filter(ele => ele !== SKIP_PC);
    if (!newGroup) {
        console.log(`setMultiPin: Error - Empty Group "${params[1]}"`);
    }
    else {
        const pc = state.everyone.get(supportPCs[params[1]]);
        sendToZoom('/zoom/users/userName/remoteAddPin', pc, newGroup);
    }
}
function muteAllExceptGroup(message, params) {
    let group;
    if (!params[1]) {
        group = DEFAULT_MX_GRP;
    }
    else {
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
function unmuteGroup(message, params) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup)
        return;
    sendToZoom('/zoom/users/zoomID/unMute', ...state.groups.get(params[1]));
    displayGroup(message.zoomID, params[1]);
}
function muteGroup(message, params) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup)
        return;
    sendToZoom('/zoom/users/zoomID/mute', ...state.groups.get(params[1]));
    displayGroup(message.zoomID, params[1]);
}
function executeRemote(message, params) {
    const curUser = getPeopleFromName(params[1]);
    if (!curUser)
        return;
    console.log(`executeRemote`);
    sendToZoom('/zoom/zoomID/chat', curUser.map(user => user.zoomID), "/xlocal ", ...params.slice[2]);
}
function executeLocal(message, params) {
    // no zoom ids found, return
    if (myZoomID) {
    }
    // Command format: /xlocal targetPC.zoomID <ZoomOSC Command> [options]`);
    // Make sure this is the targetPC
    if (Number(params[1]) == myZoomID[0]) {
        // NOTE: Not able to send all parameters at this time
        // sendToZoom(params[2], ...params.slice[3]);
        sendToZoom(params[2], params[3]);
    }
}
function parseChatParams(str) {
    // this unreadable mess does this:
    // . change curly-quotes to straight quotes (zoom tries to be smart about quotes)
    // . combine words in quotes to be a single param. eg: param1 "second param" 'third param'
    return str && (String(str)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .match(/[^\s"]+|"([^"]*)"/gi) || []).map((word) => word.replace(/^"(.+(?="$))"$/, '$1'));
}
function handleUnmute(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    person.audioOn = true;
    // console.log("handleUnmute message, person", message, person);
}
function handleMute(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    person.audioOn = false;
    // console.log("handleMute message, person", message, person);
}
function handleVideoOn(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    person.videoOn = true;
    // console.log("handleVideoOn message, person", message, person);
}
function handleVideoOff(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    person.videoOn = false;
    // console.log("handleVideoOff message, person", message, person);
}
function handleRoleChanged(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    person.userRole = Number(message.params[0]);
    // console.log("handleRoleChanged message, person", message, person);
}
function addZoomIDToName(name, zoomID) {
    const zoomIDs = state.names.get(name);
    if (!zoomIDs) {
        state.names.set(name, [zoomID]);
        return;
    }
    // if it's already there, we're done
    if (zoomIDs.includes(zoomID))
        return;
    state.names.set(name, [...zoomIDs, zoomID]);
}
function removeZoomIDFromName(name, zoomID) {
    const zoomIDs = state.names.get(name);
    // no zoom ids found, return
    if (!zoomIDs)
        return;
    // example of how to call a function inside a filter
    const newZoomIDs = zoomIDs.filter((id) => {
        console.log(`does ${id} == ${zoomID}?`);
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
function handleNameChanged(message) {
    const person = state.everyone.get(message.zoomID);
    if (!person)
        return;
    // update the names table
    removeZoomIDFromName(person.userName, message.zoomID);
    addZoomIDToName(message.userName, message.zoomID);
    console.log(`handleuserNameChanged zoomID: ${message.zoomID}, oldName: ${person.userName}, newName: ${message.userName}`);
    person.userName = message.userName;
    // Check if myName needs to be updated
    if (message.zoomID == myZoomID[0]) {
        myName = message.userName;
    }
}
function handleOnline(message) {
    let person = state.everyone.get(message.zoomID);
    if (person)
        return;
    person = {
        zoomID: message.zoomID,
        userName: message.userName,
        userRole: USERROLE_NONE,
        audioOn: false,
        videoOn: false
    };
    state.everyone.set(person.zoomID, person);
    addZoomIDToName(message.userName, message.zoomID);
    console.log("handleOnline message, person", message, person);
}
function handleList(message) {
    let person = state.everyone.get(message.zoomID);
    if (!person) {
        person = {
            zoomID: message.zoomID,
            userName: message.userName,
            userRole: Number(message.params[2]),
            audioOn: Boolean(message.params[5]),
            videoOn: Boolean(message.params[4])
        };
        state.everyone.set(person.zoomID, person);
    }
    else {
        person.userName = message.userName;
        person.userRole = Number(message.params[2]);
        person.audioOn = Boolean(message.params[5]);
        person.videoOn = Boolean(message.params[4]);
    }
    addZoomIDToName(message.userName, message.zoomID);
}
function setupOscListeners() {
    // convenient code to print every incoming messagse
    // osc.on('*', message => {
    //      console.log("OSC * Message", message)
    // });
    osc.on('/zoomosc/user/chat', (message) => __awaiter(this, void 0, void 0, function* () { return handleChatMessage(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/unMute', (message) => __awaiter(this, void 0, void 0, function* () { return handleUnmute(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/mute', (message) => __awaiter(this, void 0, void 0, function* () { return handleMute(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/videoOn', (message) => __awaiter(this, void 0, void 0, function* () { return handleVideoOn(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/videoOff', (message) => __awaiter(this, void 0, void 0, function* () { return handleVideoOff(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/roleChanged', (message) => __awaiter(this, void 0, void 0, function* () { return handleRoleChanged(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/userNameChanged', (message) => __awaiter(this, void 0, void 0, function* () { return handleNameChanged(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/online', (message) => __awaiter(this, void 0, void 0, function* () { return handleOnline(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/user/list', (message) => __awaiter(this, void 0, void 0, function* () { return handleList(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/chat', (message) => __awaiter(this, void 0, void 0, function* () { return handleChatMessage(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/unMute', (message) => __awaiter(this, void 0, void 0, function* () { return handleUnmute(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/mute', (message) => __awaiter(this, void 0, void 0, function* () { return handleMute(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/videoOn', (message) => __awaiter(this, void 0, void 0, function* () { return handleVideoOn(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/videoOff', (message) => __awaiter(this, void 0, void 0, function* () { return handleVideoOff(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/roleChanged', (message) => __awaiter(this, void 0, void 0, function* () { return handleRoleChanged(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/userNameChanged', (message) => __awaiter(this, void 0, void 0, function* () { return handleNameChanged(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/online', (message) => __awaiter(this, void 0, void 0, function* () { return handleOnline(parseZoomOSCMessage(message)); }));
    osc.on('/zoomosc/me/list', (message) => __awaiter(this, void 0, void 0, function* () { return handleList(parseZoomOSCMessage(message)); }));
}
// not used right now, but could be used to pause between things
// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=index.js.map