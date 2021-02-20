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

const HOST = 1;
const COHOST = 2;
const LS_SUPPORT_GRP = "ls-support";      // Must assign a group called "ls-support"
const SKIP_PC = -1;
const SKIP_PC_STRING = "-";
const DEFAULT_MX_GRP = "leaders";

// The definition of the current state of the room
interface RoomState {
    // mapping names to their zoomIDs
    names: Map<string, number[]>;

    // who are the room "leaders" (people excluded from muting)
    leaders: number[];

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
    leaders: [],
    groups: new Map<string, number[]>(),
    everyone: new Map<number, PersonState>()
}

// get this thing started
run()
    .then(() => {
        console.log('running');
    });

async function run() {

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
/h | /help	: Print this message   \n\
/l		: Manage leaders           \n\
    /l		    : Print leaders    \n\
    /l "name"	: Replace list     \n\
    /l + "name"	: Add to list      \n\
    /l - "name"	: Remove from list \n\
/ma		: Mute all users           \n\
/mx		: Mute all but leaders     \n\
/ua		: Unmute all users';

function handleChatMessage(message: ZoomOSCMessage) {
    const chatMessage = message.params;

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
    switch (params[0]) {
        case '/mx':  // mute all except leaders
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
        /* Replaced by /group command
        case '/l': // leader
            manageLeader(message, params);
            break;
            */
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
            console.log("handleChatMessage state", state);
            break;
        case '/test':
            console.log("handleChatMessage /test", params[1], params[2]);
            sendToZoom('/zoom/userName/remoteAddPin', params[1], params[2]);
            break;
        case '/h':
        case '/help':
            sendToZoom('/zoom/zoomID/chat', message.zoomID, HELPINFO);
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
    return (person.userRole == HOST) || (person.userRole == COHOST);
}

function getPeopleFromName(name: string): PersonState[] {
    const ids = state.names.get(name);
    if (!ids) return undefined;
    // return all the people with that name
    return ids.map(id => state.everyone.get(id));
}

// BB: No longer used. commented out for now
// function replaceLeader(name: string) {
//     const newLeaders: PersonState[] = getPeopleFromName(name);
//     if (!newLeaders) return;
//     state.leaders = newLeaders.map(leader => leader.zoomID);
// }

// BB: No longer used, commented out
// function addLeader(name: string) {
//     const newLeaders: PersonState[] = getPeopleFromName(name);
//     if (!newLeaders) return;
//     const leadersToAdd = newLeaders.filter(leader => !state.leaders.includes(leader.zoomID));
//     // concat old leaders and new leaders that weren't already there
//     state.leaders = [...state.leaders, ...leadersToAdd.map(leader => leader.zoomID)];
// }

// BB: No longer used
// function removeLeader(name: string) {
//     const oldLeaders: PersonState[] = getPeopleFromName(name);
//     if (!oldLeaders) return;
//     const oldLeaderZoomIDs = oldLeaders.map(ol => ol.zoomID);
//     // filter out leaders with the above name
//     state.leaders = state.leaders.filter(leaderID => oldLeaderZoomIDs.includes(leaderID));
// }

// BB: No longer used
// function displayLeaders(zoomid: number, leaders: number[]) {
//     let buffer = "Leaders: None Specified";
//
//     for (let i = 0; i < leaders.length; i++) {
//         const person = state.everyone.get(leaders[i]);
//         if (i === 0) {
//             buffer = "Leaders: " + person.userName;
//         } else {
//             buffer = buffer.concat(", ", person.userName);
//         }
//     }
//     console.log("manageLeader", buffer);
//     sendToZoom('/zoom/zoomID/chat', zoomid, buffer);
// }

// BB: this is no longer used. Commented out in case you still want it
// function manageLeader(message: ZoomOSCMessage, params: string[]) {
//     console.log("manageLeader", params);
//     if (params.length > 1) {
//         switch (params[1]) {
//             case '+':  // add leader
//                 addLeader(params[2]);
//                 console.log("manageLeader case +", params);
//                 break;
//             case '-':  // remove leader
//                 removeLeader(params[2]);
//                 break;
//             default:   // replace leader
//                 replaceLeader(params[1]);
//         }
//     }
//
//     displayLeaders(message.zoomID, state.leaders);
// }

function createGroup(params: string[]) {
    let zoomidList: number[] = [];

    const namesList = params.slice(2);

    namesList.forEach((name) => {
        const curUser: PersonState[] = getPeopleFromName(name);
        if (!curUser) {
            if (name === SKIP_PC_STRING) {
                zoomidList.push(SKIP_PC);
            } else {
                console.log(`createGroup: Error - User "${ name }" does not exist`);
            }
        } else {
            zoomidList.push(...curUser.map(user => user.zoomID));
        }
    });

    state.groups.set(params[1], zoomidList);
}

function displayGroup(zoomid: number, param: string) {
    if (!state.groups.get(param)) return;
    console.log("displayGroup", zoomid, state.groups.get(param));
    //sendToZoom('/zoom/zoomID/chat', zoomid, buffer);
}

function manageGroups(message: ZoomOSCMessage, params: string[]) {
    console.log("manageGroups: 1", params, params.length);
    if (params.length > 2) {
        createGroup(params);
    }

    displayGroup(message.zoomID, params[1]);
}

function setPin(message: ZoomOSCMessage, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[1]);

    let pos = -1;
    currentGroup.forEach(function (zoomid) {
        pos++;
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const pc = state.everyone.get(supportPCs[pos]);
        const name = person.userName;

        if (!person) {
            console.log(`setPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            sendToZoom('/zoom/userName/remotePin2', pc.userName, name);
        }
    });
}

function setMultiPin(message: ZoomOSCMessage, params: string[]) {
    const supportPCs = state.groups.get(LS_SUPPORT_GRP);
    const currentGroup = state.groups.get(params[2]);

    // This is a work in progress - Turns out that ZoomOSC doesn't support /users for remoteAddPin ( also a PRO feature )

    console.log(`setMultiPin: params ${ params }, currentGroup ${ currentGroup }`);

    const newGroup = currentGroup.filter(ele => ele !== SKIP_PC);

    // BB: this was never used, I commented it out in case you still want it around
    // const newGroupNames = newGroup.filter((zoomid) => {
    //     const person = state.everyone.get(zoomid);
    //     const name = person.userName;
    //     return (name);
    // });

    if (!newGroup) {
        console.log(`setMultiPin: Error - Empty Group "${ params[1] }"`);
    } else {
        const pc = state.everyone.get(supportPCs[params[1]]);
        sendToZoom('/zoom/users/userName/remoteAddPin', pc, newGroup);
    }
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
    displayGroup(message.zoomID, params[1]);
}

function muteGroup(message: ZoomOSCMessage, params: string[]) {
    const curGroup = state.groups.get(params[1]);
    if (!curGroup) return;

    sendToZoom('/zoom/users/zoomID/mute', ...state.groups.get(params[1]));
    displayGroup(message.zoomID, params[1]);
}


function parseChatParams(str: string): string[] {
    // this unreadable mess does this:
    // . change curly-quotes to straight quotes (zoom tries to be smart about quotes)
    // . combine words in quotes to be a single param. eg: param1 "second param" 'third param'
    return str && (String(str)
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .match(/[^\s"]+|"([^"]*)"/gi) || []).map((word) =>
        word.replace(/^"(.+(?="$))"$/, '$1'));
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
}

function handleOnline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);
    if (person) return;

    person = {
        zoomID: message.zoomID,
        userName: message.userName,
        userRole: 0,
        audioOn: false,
        videoOn: false
    }
    state.everyone.set(person.zoomID, person);
    addZoomIDToName(message.userName, message.zoomID);
    console.log("handleOnline message, person", message, person);
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

function setupOscListeners() {

    // convenient code to print every incoming messagse
    // osc.on('*', message => {
    //      console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/user/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));

    osc.on('/zoomosc/me/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/userNameChanged', async message => handleNameChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/online', async message => handleOnline(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/me/list', async message => handleList(parseZoomOSCMessage(message)));
}

// not used right now, but could be used to pause between things
// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
