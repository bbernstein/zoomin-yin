# zoomin-yin

This tool helps manage large groups of people using ZoomOSC

You need [nodejs](https://nodejs.org/en/) installed to build and use it.

## Requirements

- [ZoomOSC](https://www.liminalet.com/zoomosc)

## To Run

### tl;dr (for Mac)

1. Have [nodejs](https://nodejs.org/en/) installed.
2. Double-click `START.command`
3. Start using it

### Manually run with npm

```
npm install
```

```
npm start
```

## To Setup

By default, this app listens to port 1234 on all network devices, so you should be able to reach it
from other computers. If you want to change the host or port of the listener, you can set
environment variable `LISTEN_PORT`.

If ZoomOSC is listening to a different port than the default 9090, or on a different host machine,
you can set `ZOOMOSC_HOST` and `ZOOMOSC_PORT`.


## Commands

Any host can send chat messages to this user and it will do things:

### List all users
```
/list
```

### Manage leaders

With no parameters, it just lists current leaders.

```
/l
```

With a name given (in quotes if multiple words) it adds tha tuser to the leader list.
```
/l <username>
```

### Mute all except leaders
```
/mx
```

### Unmute everyone
```
/ua

```

### Mute everyone
```
/ma

```
