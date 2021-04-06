import * as fs from 'fs';
import * as OSC from 'osc-js';
import {
    ChronoUnit,
    DateTimeFormatter,
    Duration,
    LocalDate,
    LocalDateTime,
    LocalTime
} from '@js-joda/core';

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
const DEFAULT_DURATION = "PT1H";
const CONFIG_POLL_TIME = 15000;

// const SKIP_CURRENT = true;
// const DONT_SKIP_CURRENT = false;

// for testing, fill in the date/time for "now" to see what happens, otherwise set it to null
// (comment out one of these two)
// const fakeNow = LocalDateTime.of(
//     LocalDate.parse("2021-04-21", DateTimeFormatter.ISO_LOCAL_DATE),
//     LocalTime.parse("09:15", DateTimeFormatter.ofPattern('HH:mm'))
// );
const fakeNow = null;


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

// The ZoomOSC incoming user message with params broken out
interface PongReply {
    pingArg: any;
    zoomOSCversion: string;
    subscribeMode: number;
    galTrackMode: number;
    callStatus: number;
    numTargets: number;
    numUsers: number;
    isPro: boolean;
}

// The value of the room state
const state: RoomState = {
    names: new Map<string, number[]>(),
    groups: new Map<string, number[]>(),
    everyone: new Map<number, PersonState>()
}

interface MeetingConfig {
    name: string;
    exclude?: string;
    meetingID: string;
    meetingPass?: string;
    userName?: string;
    date?: string;
    time?: string;
    duration?: string;
    maxDuration?: string;
    codeWord?: string;
    startDateTime?: LocalDateTime;
    endDateTime?: LocalDateTime;
    maxEndDateTime?: LocalDateTime;
}

interface Config {
    default: string;
    defaultCodeWord: string;
    meetings: MeetingConfig[];
}

let ZoomOSCInfo: PongReply;
let gCurrentMeetingConfig: MeetingConfig;
let gDefaultCodeWord: string;
let disableStartMeeting = false;
let configLastModified: number;
let configFileChecked = false;   // Used to limit numnber of warnings/errors in calculateMeeting

// get this thing started
run()
    .then(() => {
        sendMessage(null,`running ...`);
    });

// use this so we can test with fake "current" times easily (there are other ways, but its a little complicated)
function getNow(): LocalDateTime {
    return fakeNow || LocalDateTime.now();
}

async function readConfig(): Promise<Config> {
    const configFile = fs.readFileSync('config.json');
    const config = JSON.parse(configFile.toString());
    gDefaultCodeWord = config.defaultCodeWord;
    config.meetings = calculateMeetingTimes(config.meetings);
    return config;
}

function calculateMeetingTimes(meetings: MeetingConfig[]): MeetingConfig[] {
    const today = getNow().toLocalDate();

    /**
     * Make a list of meetings that include their LocalDateTime versions.
     * Sorted by start time
     * With all conflicts removed or reported.
     * If a default meeting (no date given) overlaps with a dated meeting, it is removed
     * If two dated or default meetings overlap, they are reported with warning
     */
    const orderedMeetings =
        meetings.map(meeting => {

            if (!meeting.codeWord) {
                meeting.codeWord = gDefaultCodeWord;
            }

            if (!meeting.time) return;
            const date = meeting.date
                ? LocalDate.parse(meeting.date, DateTimeFormatter.ISO_LOCAL_DATE)
                : today;
            const time = LocalTime.parse(meeting.time, DateTimeFormatter.ofPattern('HH:mm'));
            meeting.startDateTime = LocalDateTime.of(date, time);

            // calculate endDateTime from the start and duration
            const duration =
                meeting.duration
                    ? Duration.parse(meeting.duration)
                    : Duration.parse(DEFAULT_DURATION);
            meeting.endDateTime = meeting.startDateTime.plus(duration);

            // calculate maxEndDateTime from the start and maxDuration (default is duration from above)
            const maxDuration =
                meeting.maxDuration
                    ? Duration.parse(meeting.maxDuration)
                    : duration;
            meeting.maxEndDateTime = meeting.startDateTime.plus(maxDuration);

            // maxEndDateTime must be after the scheduled endDateTime
            if (meeting.maxEndDateTime.isBefore(meeting.endDateTime)) meeting.maxEndDateTime = meeting.endDateTime;
      
            // Use the default codeWord if one isn't specified in the config for this meeting.
            if (!meeting.codeWord) meeting.codeWord = gDefaultCodeWord;

            return meeting;
        })

            // sort them by startDates
            .sort(compareMeetingDates);

    // get only meetings that either have a date or are undated with no overlapping dated meetings
    const filteredMeetings = orderedMeetings
        .filter(meeting => {
            // don't filter out one with a date
            if (meeting.date) return true;

            // find a meeting that has a date && overlaps this meeting (if so, filter it out)
            const overlappingMeeting = orderedMeetings.find(otherMeeting => {
                return otherMeeting.date && overlaps(meeting, otherMeeting)
            });
            if (!configFileChecked && overlappingMeeting) {
                // found an overlap, report a warning
                console.error(`WARNING: ignoring default meeting: [${ toShortString(meeting) }]. Overridden by [${ toShortString(overlappingMeeting) }]`);
            }
            return !overlappingMeeting && !meeting.exclude;
        });

    // no changes, just report any overlaps remaining between meetings of same priority
    filteredMeetings.forEach(meeting => {
        const overlappingMeetings = filteredMeetings.filter(otherMeeting =>
            meeting !== otherMeeting &&
            meeting.startDateTime.compareTo(otherMeeting.startDateTime) >= 0 &&
            overlaps(meeting, otherMeeting));

        if (!configFileChecked && overlappingMeetings.length > 0) {
            // report all of the overlaps with this meeting (could repeat when multiple start at same time
            overlappingMeetings.forEach(om => {
                console.error(`WARNING: conflicting meetings: [${ toShortString(meeting) }] overlaps [${ toShortString(om) }]`);
            })
        }
    });

    return filteredMeetings;
}

/**
 * This is a simple string to identify a meeting
 *
 * TODO: You may want to add more fields. This is for output in a single line.
 * Another function could be written to show all the details
 */
function toShortString(meeting: MeetingConfig): string {
    return `${ meeting.name } / ${ meeting.date ? meeting.date : "UNDATED" } / ${ meeting.time }`;
}


function overlaps(meeting1: MeetingConfig, meeting2: MeetingConfig): boolean {
    // note: if one starts at the same time the other ends, it's still no overlap (hence "or equals")
    return meeting1.startDateTime.compareTo(meeting2.endDateTime) <= 0 &&
        meeting2.startDateTime.compareTo(meeting1.endDateTime) <= 0;
}

function startMeeting(meetingConfig: MeetingConfig) {

    if (!meetingConfig || (meetingConfig.exclude == "true")) return;

    const now = getNow();

    const startTime = meetingConfig.startDateTime;
    const duration = Duration.parse(meetingConfig.duration);
    // Start/Join meeting if it's the current meeting
    if (now.isEqual(startTime) || (now.isAfter(startTime) && now.isBefore(startTime.plus(duration)))) {
        sendMessage(null,"startMeeting: Start/Join Meeting", meetingConfig);
        const spacelessMeetingId = String(meetingConfig.meetingID).replace(/ /g, "");
        if (meetingConfig.meetingPass) {
            sendToZoom('/zoom/joinMeeting', spacelessMeetingId, meetingConfig.meetingPass, meetingConfig.userName);
        } else {
            sendToZoom('/zoom/joinMeeting', spacelessMeetingId, meetingConfig.userName);
        }
    }

    // keep this global so we can check its codeword and things like that
    gCurrentMeetingConfig = meetingConfig;

    // Stop trying to start a new meeting until this one has ended.
    disableStartMeeting = true;
}

// return -1 if meeting1 is lower, 1 if meeting2 is lower, 0 if they are equal
function compareMeetingDates(meeting1, meeting2): number {
    return meeting1.startDateTime.compareTo(meeting2.startDateTime)
}

/**
 * Return the meeting that was scheduled to have started in the past but hasn't yet ended
 * If there are multiple meetings now, it will return the first one that has today's date
 */
function currentMeeting(meetings: MeetingConfig[]): MeetingConfig {
    const now = getNow();
    const allCurrentMeetings = meetings

        // only include meetings that had already started and haven't yet ended
        .filter(meeting => meeting.startDateTime.compareTo(now) <= 0 && meeting.endDateTime.compareTo(now) >= 0)

        // ones that have a date take priority over ones that don't
        .sort(compareMeetingDates);

    // if there was at least one match, return the first. They are sorted so that dated ones come before defaults
    return allCurrentMeetings.length > 0 && allCurrentMeetings[0];
}

/**
 * Return the next meeting that hasn't yet started.
 * If there are multiple meetings coming up at the same time, it will choose the one that is scheduled for today.
 * TODO: this isn't used right now
 */
function nextMeeting(meetings: MeetingConfig[]): MeetingConfig {
    const now = getNow();

    const allFutureMeetings = meetings

        // filter to only include possible future meetings (or current)
        .filter(meeting => {

            // only include meetings that haven't started yet
            return meeting.startDateTime && (meeting.startDateTime.compareTo(now) >= 0);
        })

        // sort in order so the next one is the first
        .sort(compareMeetingDates);

    return allFutureMeetings.length > 0 && allFutureMeetings[0];
}

async function run() {

    // myName and primaryMode are need to support /xlocal commands

    // FIXME: Get myName from the command line until we find a way to figure it out from ZoomOSC
    if (process.argv[2]) {
        myName = process.argv[2];
    }

    if (process.argv[3]) {
        primaryMode = (process.argv[3] != "-secondary");
    }

    sendMessage(null,`running in ${ primaryMode ? "Primary" : "Secondary" } mode`);
    sendMessage(null,`running as user "${ myName }"`);

    // prepare to listen to OSC
    setupOscListeners();

    // start listening
    osc.open();
    sendMessage(null,`Listening to ${ osc.options.plugin.options.open.host }:${ osc.options.plugin.options.open.port }`);

    // tell ZoomOSC to listen to updates about the users
    sendToZoom('/zoom/subscribe', 2);

    // get ZoomOSCInfo
    sendToZoom('/zoom/ping', "ZoomOSC Information");

    // read the config file and start/join the current meeting (if not already started)
    if (primaryMode) {

        // Config file
        // Notes about time / date formats
        //   Duration in ISO8601 formats:
        //   duration format: https://www.digi.com/resources/documentation/digidocs/90001437-13/reference/r_iso_8601_duration_format.htm
        //   Date format: HHHH-MM-DD
        //   Time format: hh:mm (24-hour time)
        //   Duration formation simple form: PT2H15M
        //      PT: Period Time       2H: two hours       15M: fifteen minutes

        await checkForUpdates();
    }
 } 

let numberJoined = 0;

async function checkForUpdates() {

    const now = getNow();

    // Manage flags to indicate when the config file should be read
    // Once a meeting is started, stop trying to start a new one until the current meeting has ended. 

    // If the config file has been modified, clear start meeting flags and see if there is a meeting to start
    const configFileStats = fs.statSync('config.json');
    const mtimeMs = configFileStats.mtimeMs;
    if (!configLastModified || (mtimeMs !== configLastModified)) {
        sendMessage(null,"readConfig: config file has been modified")
        configLastModified = mtimeMs;
        disableStartMeeting = false;
        gCurrentMeetingConfig = null;
        configFileChecked = false;
    }

    // Start/Join the current meeting if one exists
    if (!disableStartMeeting) {
        const config = await readConfig();
        const meeting = currentMeeting(config.meetings);

        startMeeting(meeting);

        // Set flag to mask future Warnings/Errors in calculateMeeting
        configFileChecked = true;
    }

    // After the scheduled end time of the current meeting it's OK to start the next meeting
    if (gCurrentMeetingConfig && now.isAfter(gCurrentMeetingConfig.endDateTime)) {
        disableStartMeeting = false;
    }

    // Stop the current meeting if it has reached the maxDuration
    if (gCurrentMeetingConfig && now.isAfter(gCurrentMeetingConfig.maxEndDateTime)) {
        sendToZoom("/zoom/endMeeting");
        disableStartMeeting = false;
        gCurrentMeetingConfig = null;
    }

    // FIXME: ZoomOSC is not issuing a /list after a member joins. 
    //        For now issue a /list command each time there is a change in the number of meeting members
    if ((state.names.size > 0) && (numberJoined != state.names.size)) {
        sendToZoom('/zoom/list');
    }
    numberJoined = state.names.size;

    // check again after the specified poll time
    setTimeout(checkForUpdates, CONFIG_POLL_TIME);
}

function sendToZoom(message: string, ...args: any[]) {
    sendMessage(null,`Sending to Zoom: ${message} ${args}`);
    try {
        osc.send(new OSC.Message(message, ...args));
    } catch (e) {
        console.error("Failed to sendToZoom", e);
    }
}

function sendMessage(recipientZoomID: number, message: string, ...args: any[]) {
    const today = getNow().toLocaleString().substring(0, 19)
        .replace(/T/g, " ");

    console.log(today, message, ...args);

    if (!recipientZoomID) return;

    sendToZoom('/zoom/zoomID/chat', recipientZoomID, message, ...args);
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

function handleChatMessage(message: ZoomOSCMessage) {
    const chatMessage = message.params[0];
    if (chatMessage.charAt(0) !== '/') return;

    // clean the quotes before moving on
    cleanCurlyQuotes(chatMessage)

        // split each of the lines into an array item
        .split('\n')

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

    const params = wordify(chatMessage);

    // Process special commands /cohost and /end that require a password
    if (processSpecial(message.zoomID, params)) {
        return;
    }

    // only /xlocal command is allowed in Secondary mode
    if (!primaryMode && !(params[0] == "/xlocal")) {
        return;
    }

    // only deal with chat messages from a host, else exit
    // FIXME: For secondary clients, we don't know the state info for the users.  For now, don't do isHost check for /xlocal commands
    // if (!isHost(message.zoomID)) {
    if (!(params[0] == "/xlocal") && !isHost(message.zoomID)) {
        sendMessage(message.zoomID, "Error: Only the Host and Co-hosts can issue Chat Commands");
        return;
    }

    // slash-command, do something with it
    // const params = wordify(chatMessage);
    console.log("args", params);

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
            sendMessage(null, `\n state:`, state);
            break;

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
            // console.log("quicktest host", params[1]);
            // sendToZoom("/zoom/userName/makeCoHost", params[1] );
            break;
        default:
            sendMessage(message.zoomID, "Error: Unimplemented Chat Command");
    }
}

function processSpecial(recipientZoomID: number, params: string[]): boolean {
    let specialCommand = true;
    switch (params[0]) {
        case '/cohost':
            if (checkPassword(recipientZoomID, params.slice(2))) {
                //check if person exists
                const personExists = getPeopleFromName(params[1]);
                if (!personExists) {
                    sendMessage(recipientZoomID, `processSpecial: Error - User "${ params[1] }" does not exist`);
                } else {
                    sendToZoom('/zoom/userName/makeCoHost', params[1]);
                }
            }
            break;
        case '/end':
            if (!isHost(recipientZoomID)) {
                sendMessage(recipientZoomID, "Error: Only the Host and Co-hosts can issue Chat Commands");
            } else {
                if (checkPassword(recipientZoomID, params.slice(1))) {
                    sendToZoom("/zoom/endMeeting");
                }
            }
            break;
        default:
            specialCommand = false;
    }
    return (specialCommand);
}

function checkPassword(recipientZoomID: number, params: string[]): boolean {
    let passwordValid = false;

 //   if (!gCurrentMeetingConfig || !gCurrentMeetingConfig.codeWord) {
    if (!gCurrentMeetingConfig) {

        sendMessage(recipientZoomID, `Error - This meeting is not configured for special command processing`);
        return (passwordValid);
    }

    if (!params[0]) {
        sendMessage(recipientZoomID, `Error - Password required for this command`);
        return (passwordValid);
    }

    if (params[0] !== gCurrentMeetingConfig.codeWord) {
        sendMessage(recipientZoomID, `Error - Invalid Password`);
        return (passwordValid);
    }
    passwordValid = true;
    return (passwordValid);
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
                sendMessage(recipientZoomID, `createGroup: Error - User "${ name }" does not exist`);
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
        sendMessage(recipientZoomID, `displayGroup Error: Group "${ param }" does not exist`);
        return;
    }

    state.groups.delete(param);
}

function displayGroup(recipientZoomID: number, param: string) {
    const members = state.groups.get(param);

    if (!members) {
        sendMessage(recipientZoomID, `displayGroup Error: Group "${ param }" does not exist`);
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

    sendMessage(recipientZoomID, buffer);
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
        sendMessage(recipientZoomID, `displayName Error: Name "${ param }" does not exist`);
        return;
    }

    let buffer = "";
    members.forEach((zoomid) => {
        const person = state.everyone.get(zoomid);
        const name = person.userName;
        buffer = buffer.concat("\"" + name + "\"\n");
    });

    sendMessage(recipientZoomID, buffer);
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
                sendMessage(recipientZoomID, "Error: Unimplemented Groups Sub-Command");
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
        sendMessage(recipientZoomID, `setPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }

    // Make sure group exists
    if (!currentGroup) {
        sendMessage(recipientZoomID, `setPin Error: Group "${ params[1] }" does not exist`);
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
            sendMessage(recipientZoomID, `setPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            // Check if I'm the target
            if (targetPC.userName == myName) {
                sendToZoom("/zoom/zoomID/pin2", zoomid);
            } else {
                // FIXME: Prefer to use zoomID instead of userName, but zoomID state not maintained (yet) in secondary mode
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/zoomID/pin2 ${ zoomid }`);
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
        sendMessage(recipientZoomID, `setMultiPin Error: User "${ multipinDevice }" does not exist`);
        return;
    }
    // Make sure LS-SUPPORT group exists
    if (!supportPCs) {
        sendMessage(recipientZoomID, `setMultiPin Error: LS-SUPPORT Group "${ LS_SUPPORT_GRP }" does not exist`);
        return;
    }
    // Make sure device is in LS-SUPPORT group
    const gotit = supportPCs.filter(id => id == device[0].zoomID);
    if (gotit.length == 0) {
        sendMessage(recipientZoomID, `setMultiPin Error: Device: "${ multipinDevice }" is not included in Group: "${ LS_SUPPORT_GRP }"`);
        return;
    }
    // Make sure Multipin group exists
    if (!currentGroup) {
        sendMessage(recipientZoomID, `setMultiPin Error: Group "${ params[1] }" does not exist`);
        return;
    }

    const targetPC = state.everyone.get(device[0].zoomID);

    // Clear all Pins before adding new group
    if (targetPC.userName == myName) {
        sendMessage(null, `setMultiPin:`);
        sendToZoom("/zoom/me/clearPin");
    } else {
        sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/me/clearPin`);
    }

    currentGroup.forEach(function (zoomid) {
        if (zoomid == SKIP_PC) return;

        const person = state.everyone.get(zoomid);
        const name = person.userName;

        if (!person) {
            sendMessage(recipientZoomID, `setMultiPin: Error - User "${ person.zoomID }" does not exist`);
        } else {
            if (targetPC.userName == myName) {
                sendToZoom("/zoom/zoomID/addPin", zoomid);
            } else {
                // FIXME: Prefer to use zoomID instead of userName, but zoomID state not maintained (yet) in secondary mode
                //        Also, not sure if addPin works with a list of zoomID's
                sendToZoom('/zoom/zoomID/chat', targetPC.zoomID, `/xlocal "${ targetPC.userName }" /zoom/zoomID/addPin ${ zoomid }`);
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
    sendMessage(null,`executeLocal myName = "${ myName }"`, params);
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
            .replace(/[\r]/g, "\n")
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
    sendMessage(null,`handleuserNameChanged zoomID: ${ message.zoomID }, oldName: ${ person.userName }, newName: ${ message.userName }`);

    person.userName = message.userName;

    // Check if myName needs to be updated
    if (message.zoomID == myZoomID[0]) {
        myName = message.userName;
    }
}

function handleOnline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

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
    sendMessage(null, "handleOnline message, person", message, person);

    // FIXME: ZoomOSC doesn't support "Mute Participants upon Entry"
    //        For now manually mute people upon entry after 25 have joined the meeting
    if (state.names.size > 25) {
        sendToZoom('/zoom/zoomID/mute', person.zoomID);
    }
}

// FIXME: ZoomOSC is not issuing the offline command yet
function handleOffline(message: ZoomOSCMessage) {
    let person: PersonState = state.everyone.get(message.zoomID);

    if (person) return;

    sendMessage(null,"handleOffline message, person", message, person);
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

function handleMeetingStatus(message: ZoomOSCMessage) {
    state.names.clear();
    state.groups.clear();
    state.everyone.clear();

    sendMessage(null,"handleMeetingStatus", message.targetID);
 
    // When meeting starts - ask for snapshot of the users who were there first
    // Note: Normal message parameters don't apply here, use the first parameter. 
    if (Number(message.targetID) == 1) {
        sendToZoom('/zoom/list');
    }
}

function handlePongReply(message: ZoomOSCMessage) {

    ZoomOSCInfo = {
        pingArg: message.params[0],
        zoomOSCversion: String(message.params[1]),
        subscribeMode: Number(message.params[2]),
        galTrackMode: Number(message.params[3]),
        callStatus: Number(message.params[4]),
        numTargets: Number(message.params[5]),
        numUsers: Number(message.params[6]),
        isPro: Boolean(message.params[7])
    }

    console.log("pong", message, ZoomOSCInfo);
}


function setupOscListeners() {

    // convenient code to print every incoming messagse
    // osc.on('*', message => {
    //     console.log("OSC * Message", message)
    // });

    osc.on('/zoomosc/meetingStatus', async message => handleMeetingStatus(parseZoomOSCMessage(message)));
    osc.on('/zoomosc/pong', async message => handlePongReply(parseZoomOSCMessage(message)));

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
