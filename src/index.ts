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

interface RoomState {
    names: Map<string, number>;
    leaders: number[];
    everyone: Map<number, PersonState>;
}

interface PersonState {
    zoomID: number;
    userName: string;
    userRole: number;
    audioOn: boolean;
    videoOn: boolean;
}

interface ZoomOSCMessage {
    address: string;
    targetID: number;
    userName: string;
    galIndex: number;
    zoomID: number;
    params: string;
}

const state: RoomState = {
    names: new Map<string, number>(),
    leaders: [],
    everyone: new Map<number, PersonState>()
}

run()
    .then(() => {
        console.log('running');
    });

async function run() {
    setupOscListeners();
    osc.open();
    console.log(`Listening to ${ osc.options.plugin.options.open.host }:${ osc.options.plugin.options.open.port }`);

    sendToZoom('/zoom/subscribe', 2);
    sendToZoom('/zoom/list');    // Fetch the current list of users
}

function sendToZoom(message: string, ...args: any[]) {
    console.log("Sending to Zoom: %s, %s", message, args);
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}

function parseZoomOSCMessage(message) {
    console.log("raw message:", message);

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

function handleChatMessage(message: ZoomOSCMessage) {
    const chatMessage = message.params;
    if (chatMessage[0] === '/') {
        // slash-command, do something with it
        //if (!amHost(message.zoomID)) {
        //	return;
        //}

        const params = parseChatParams(chatMessage);
        console.log("args", params);
        switch (params[0]) {
            case '/mx':  // mute all except leaders
                muteNonLeaders();
                break;
            case '/ua': // unmute all
                sendToZoom('/zoom/all/unMute');
                break;
            case '/ma': // mute all
                sendToZoom('/zoom/all/mute');
                break;
            case '/l': // leader
                manageLeader(message, params);
                break;
            case '/list': // list all users
                sendToZoom('/zoom/list');
                break;
            case '/state':
                console.log("handleChatMessage state", state);
                break;
            default:
                console.log("handleChatMessage Error: Unimplemented Chat Command");
                sendToZoom('/zoom/zoomID/chat', message.zoomID, "Error: Unimplemented Chat Command");
        }
    }
}

function getPersonFromName(name: string) {
    const id = state.names.get(name);
    if (!id) return undefined;
    return state.everyone.get(id);
}

function replaceLeader(name: string) {
    const newLeader: PersonState = getPersonFromName(name);
    if (!newLeader) return;
    state.leaders = [newLeader.zoomID];
}

function addLeader(name: string) {
    const newLeader: PersonState = getPersonFromName(name);
    if (!newLeader) return;
    if (state.leaders.includes(newLeader.zoomID)) return;       // already there as a leader
    state.leaders.push(newLeader.zoomID);
}

function removeLeader(name: string) {
    const newLeader: PersonState = getPersonFromName(name);
    if (!newLeader) return;
    if (state.leaders.includes(newLeader.zoomID)){      // already there as a leader
        state.leaders.splice(state.leaders.findIndex(element => element == newLeader.zoomID),1);
    }
}

function displayLeaders(zoomid: number, leaders: number[]) {
    var person: PersonState;
    var buffer;

    buffer = "Leaders: None Specified";

    for (let i = 0; i < leaders.length; i++) {
        const person = state.everyone.get(leaders[i]);
        if (i == 0) {
            buffer = "Leaders: " + person.userName;
        } else {
            buffer = buffer.concat(", ", person.userName);
        }
    }
    console.log("manageLeader", buffer);
    sendToZoom('/zoom/zoomID/chat', zoomid, buffer);
}

function manageLeader(message: ZoomOSCMessage, params: string[]) {
    console.log("manageLeader", params);
    if (params[1]) {
        switch (params[1]) {
            case '+':  // add leader
                addLeader(params[2]);
                console.log("manageLeader case +", params);
                break;
            case '-':  // remove leader
                removeLeader(params[2]);
                break;
            default:   // replace leader
                replaceLeader(params[1]);
        }
    }

    displayLeaders(message.zoomID, state.leaders);
}

function muteNonLeaders() {
    if (state.leaders.length === 0) {
        // no leaders, mute everyone
        sendToZoom('/zoom/all/mute');
        return;
    }

    // mute all but the leaders
    sendToZoom('/zoom/allExcept/zoomID/mute', ...state.leaders);
    sendToZoom('/zoom/zoomID/unMute', ...state.leaders);
}

function parseChatParams(str: string): string[] {
    return (str
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .match(/[^\s"]+|"([^"]*)"/gi) || []).map((word) =>
        word.replace(/^"(.+(?="$))"$/, '$1'));
}

function handleUnmute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.audioOn = true;
}

function handleMute(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.audioOn = false;
}

function handleVideoOn(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.videoOn = true;
}

function handleVideoOff(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.videoOn = false;
}

function handleRoleChanged(message: ZoomOSCMessage) {
    const person = state.everyone.get(message.zoomID);
    person.userRole = Number(message.params[2]);
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
    state.names.set(message.userName, message.zoomID);
}

function setupOscListeners() {

    // osc.on('*', message => {
    //     console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/user/chat', async message => handleChatMessage(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/unMute', async message => handleUnmute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/mute', async message => handleMute(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOn', async message => handleVideoOn(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/videoOff', async message => handleVideoOff(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/roleChanged', async message => handleRoleChanged(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));

    // osc.on('/zoomosc/user/list', async message => handleList(parseZoomOSCMessage(message)));

    // osc.on('/zoomosc/galleryOrder', async message => console.log("/zoomosc/galleryOrder", message.args));
    // osc.on('/zoomosc/galleryCount', async message => console.log("/zoomosc/galleryCount", message.args));
    // osc.on('/zoomosc/galleryShape', async message => console.log("/zoomosc/galleryShape", message.args));
}

// noinspection JSUnusedLocalSymbols
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
