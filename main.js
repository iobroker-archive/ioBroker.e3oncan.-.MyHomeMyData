'use strict';

/*
* Unveil life data of Viessmann E3 series devices via CAN bus
*
* Based on project open3e: https://github.com/open3e/open3e
*
*/

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Loading modules:
const can             = require('socketcan');
const storage         = require('./lib/storage');
const E3DidsDict      = require('./lib/didsE3.json');
const E380DidsDict    = require('./lib/didsE380.json');
const E3100CBDidsDict = require('./lib/didsE3100CB.json');
const E3DidsWritable  = require('./lib/didsE3Writables.json');
const collect = require('./lib/canCollect');
const uds = require('./lib/canUds');
const udsScan = require('./lib/udsScan');

class E3oncan extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'e3oncan',
        });

        this.stoppingInstance    = false; // true during unLoad()
        this.e380Collect         = null;  // E380 always is assigned to external bus
        this.e3100cbCollect      = null;  // E3100CB always is assigned to external bus
        this.E3CollectInt        = {};    // Dict of collect devices on internal bus
        this.E3CollectExt        = {};    // Dict of collect devices on external bus
        this.collectTimeout      = 2000;  // Timeout (ms) for collecting data
        this.E3UdsWorkers        = {};    // Dict of standard uds workers
        this.E3UdsSID77Workers   = {};    // Dict of uds workers for service 77
        this.cntWorkersActive    = 0;     // Total number of active workers (collect + UDS)

        this.channelExt          = null;
        this.channelExtName      = '';
        this.channelInt          = null;
        this.channelIntName      = '';
        this.cntCanConnDesired   = 0;     // Number of activated CAN connections in config
        this.cntCanConnActual    = 0;     // Number if actualy connected CAN buses

        this.udsWorkers          = {};
        this.udsTimeout          = 7500;   // Timeout (ms) for normal UDS communication
        this.udsDevices          = [];     // Confirmed & edited UDS devices
        this.udsTimeDelta        = 50;     // Time delta (ms) between UDS schedules
        this.udsTimeoutHandles   = [];

        this.didsVersionTC       = '20240309';  // Change of type of numerical dids to Number at this version
        this.udsDidForScan       = 256;    // Busidentification is in this id
        this.udsDidsVarLength    = [257,258,259,260,261,262,263,264,265,266];   // Dids have variable length
        this.udsScanWorker       = new udsScan.udsScan();
        this.udsScanDevices      = [];     // UDS devices found during scan
        this.udsDevAddrs         = [];
        this.udsDevStateNames    = [];
        this.udsDidsMaxNmbr      = 3000;    // Max. number of dids per device for scan

        //this.on('install', this.onInstall.bind(this));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        //this.on('objectChange', this.onObjectChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        await this.log.info('Startup of instance '+this.namespace+': Starting.');
        //await this.log.debug('this.config:');
        //await this.log.debug(JSON.stringify(this.config));

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);

        // Collect known devices adresses:
        for (const dev of Object.values(this.config.tableUdsDevices)) {
            // @ts-ignore
            this.udsDevAddrs.push(dev.devAddr);
            // @ts-ignore
            this.udsDevStateNames.push(dev.devStateName);
        }

        // Check for updates of list of datapoints and perform update if needed:
        await this.updateDatapointsSpecific(this.config.tableUdsDevices);             // UDS devices, specific dids
        await this.updateDatapointsCommon(this.config.tableUdsDevices);               // UDS devices, common dids
        if ('e380Name' in this.config) {
            await this.updateDatapointsCommon([{devStateName: this.config.e380Name, device:'e380'}]);    // E380 Energy Meter
        }
        if ('e3100cbName' in this.config) {
            await this.updateDatapointsCommon([{devStateName: this.config.e3100cbName, device:'e3100cb'}]); // E3100CB Energy Meter
        }

        // Setup external CAN bus if required
        // ==================================

        // @ts-ignore
        if (this.config.canExtActivated) {
            this.cntCanConnDesired++;
            // @ts-ignore
            [this.channelExt, this.channelExtName] = await this.connectToCan(this.channelExt, this.config.canExtName, this.onCanMsgExt, this.onCanExtStopped);
        }

        // Setup internal CAN bus if required
        // ==================================

        // @ts-ignore
        if (this.config.canIntActivated) {
            this.cntCanConnDesired++;
            // @ts-ignore
            [this.channelInt, this.channelIntName] = await this.connectToCan(this.channelInt, this.config.canIntName, this.onCanMsgInt, this.onCanIntStopped);
        }

        if (this.cntCanConnActual == this.cntCanConnDesired) {
            // All configured CAN connections are established
            await this.setState('info.connection', true, true);
        }

        // Setup E380 collect worker:
        if (this.channelExt) this.e380Collect = await this.setupE380CollectWorker(this.config);

        // Setup E3100CB collect worker:
        if (this.channelExt) this.e3100cbCollect = await this.setupE3100cbCollectWorker(this.config);

        // Setup all configured devices for collect:
        // @ts-ignore
        if (this.channelExt) await this.setupE3CollectWorkers(this.config.tableCollectCanExt, this.E3CollectExt, this.channelExt);
        // @ts-ignore
        if (this.channelInt) await this.setupE3CollectWorkers(this.config.tableCollectCanInt, this.E3CollectInt, this.channelInt);

        // Initial setup all configured devices for UDS:
        if (this.channelExt) await this.setupUdsWorkers();

        this.log.debug('Total number of active workers: '+String(this.cntWorkersActive));

        this.log.info('Startup of instance '+this.namespace+': Done.');
    }

    // Check for updates:

    async updateDatapointsCommon(devices) {
        // Update list of common datapoints of all devices during startup of adapter
        for (const dev of Object.values(devices)) {
            let didsDictNew  = null;
            let didsWritable = null;
            switch (dev.device) {
                case 'e380':
                    didsDictNew   = E380DidsDict;
                    didsWritable  = {};
                    break;
                case 'e3100cb':
                    didsDictNew   = E3100CBDidsDict;
                    didsWritable  = {};
                    break;
                default:
                    didsDictNew   = E3DidsDict;
                    didsWritable  = E3DidsWritable;
            }
            const devDids = new storage.storageDids({stateBase:dev.devStateName, device:dev.device});
            await devDids.initStates(this, 'standby');
            await devDids.readKnownDids(this,'standby');
            if (devDids.didsDevSpecAvail) {
                if ( (devDids.didsDictDevCom.Version === undefined) ||
                    (Number(didsDictNew.Version) > Number(devDids.didsDictDevCom.Version)) ) {
                    this.log.info('Updating common datapoints to version '+didsDictNew.Version+' for device '+dev.devStateName);
                    for (const did of Object.keys(devDids.didsDictDevCom)) {
                        if ( (did != 'Version') &&  (did in didsDictNew) ) {
                            // Check for changes in datapoint structure
                            const didStateName = await devDids.getDidStr(did)+'_'+await devDids.didsDictDevCom[did].id;
                            const devStruct = await devDids.getDidStruct(this,[],devDids.didsDictDevCom[did]);
                            const E3Struct  = await devDids.getDidStruct(this,[],didsDictNew[did]);
                            if (JSON.stringify(devStruct) != JSON.stringify(E3Struct)) {
                                // Structure of datapoint has changed
                                // Replace .json and .tree state(s) based on raw data of did
                                this.log.info('  > Structure of datapoint '+didStateName+' has changed. Updating.');
                                // Delete tree states based on old structure:
                                await this.delObjectAsync(this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, { recursive: true });
                                const raw = await devDids.getObjectVal(this, dev.devStateName+'.raw.'+didStateName);
                                if (raw != null) {
                                    // Create states based on new structure if raw data is available:
                                    const cdi = await didsDictNew[did];
                                    const res = await devDids.decodeDid(this, dev.devStateName, did, cdi, devDids.toByteArray(raw));
                                    await devDids.storeObjectJson(this, did, res.idStr, this.namespace+'.'+dev.devStateName+'.json.'+didStateName, res.val);
                                    await devDids.storeObjectTree(this, did, res.idStr, this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, res.val);
                                }
                            } else {
                                // No change of structure of datapoint
                                // Check for change of data type for numerical values
                                if (Number(devDids.didsDictDevCom.Version) < Number(this.didsVersionTC)) {
                                    // Make sure, data type and role of tree objects are correct
                                    // Force update of .tree state(s) based on raw data of did
                                    if (this.udsDidsVarLength.includes(Number(did))) {
                                        // Did with variable length has to be deleted to avoid type confilct, when length gets larger in future
                                        this.log.silly('  > Delete datapoint '+didStateName+' to secure change of data type');
                                        await this.delObjectAsync(this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, { recursive: true });
                                    }
                                    const raw = await devDids.getObjectVal(this, dev.devStateName+'.raw.'+didStateName);
                                    if (raw != null) {
                                        // Update .tree states:
                                        this.log.silly('  > Update type and role of datapoint '+didStateName);
                                        const cdi = await didsDictNew[did];
                                        const res = await devDids.decodeDid(this, dev.devStateName, did, cdi, devDids.toByteArray(raw));
                                        await devDids.storeObjectTree(this, did, res.idStr, this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, res.val, true);
                                    }
                                }
                            }
                            // Update datapoint description:
                            devDids.didsDictDevCom[did] = await didsDictNew[did];
                            // Update list of writable datapoints:
                            if ( (did in didsWritable) && (!(did in devDids.didsWritable)) ) {
                                this.log.silly('  > Add '+didStateName+' to list of writable datapoints');
                                devDids.didsWritable[did] = await didsWritable[did];
                            }
                        }
                    }
                    devDids.didsDictDevCom['Version'] = didsDictNew.Version;
                }
            }
            await devDids.storeKnownDids(this);
        }
    }

    async updateDatapointsSpecific(devices) {
        // Update list of device-specific datapoints of all devices during startup of adapter
        for (const dev of Object.values(devices)) {
            const didsDictNew = E3DidsDict;
            const devDids = new storage.storageDids({stateBase:dev.devStateName, device:dev.device});
            await devDids.initStates(this, 'standby');
            await devDids.readKnownDids(this,'standby');
            if (devDids.didsDevSpecAvail) {
                if ( (devDids.didsDictDevCom.Version === undefined) ||
                    ((Number(didsDictNew.Version) > Number(devDids.didsDictDevCom.Version)) &&
                     (Number(devDids.didsDictDevCom.Version) < Number(this.didsVersionTC))) ) {
                    this.log.info('Updating device specific datapoints to version '+didsDictNew.Version+' for device '+dev.devStateName);
                    for (const did of Object.keys(devDids.didsDictDevSpec)) {
                        if (did.length <= 4) {
                            try {
                                const didNo = Number(did);
                                // Make sure, data type and role of tree objects are correct
                                // Force update of .tree state(s) based on raw data of did
                                const didStateName = await devDids.getDidStr(did)+'_'+await devDids.didsDictDevSpec[did].id;
                                if (this.udsDidsVarLength.includes(didNo)) {
                                    // Did with variable length has to be deleted to avoid type confilct, when length gets larger in future
                                    this.log.silly('  > Delete datapoint '+didStateName+' to secure change of data type');
                                    await this.delObjectAsync(this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, { recursive: true });
                                }
                                const raw = await devDids.getObjectVal(this, dev.devStateName+'.raw.'+didStateName);
                                if (raw != null) {
                                    // Update .tree states:
                                    this.log.silly('  > Update type and role of datapoint '+didStateName);
                                    const cdi = await devDids.didsDictDevSpec[did];
                                    const res = await devDids.decodeDid(this, dev.devStateName, did, cdi, devDids.toByteArray(raw));
                                    await devDids.storeObjectTree(this, did, res.idStr, this.namespace+'.'+dev.devStateName+'.tree.'+didStateName, res.val, true);
                                }
                            } catch {
                                this.log.warn('  > Could not update did '+did+' because of wrong format (expected a number).');
                                continue;
                            }
                        }
                    }
                }
            }
        }
    }

    // Setup CAN busses

    async connectToCan(channel, name, onMsg, onStop) {
        let chName = name;
        if (!channel) {
            try {
                channel = can.createRawChannel(name, true);
                await channel.addListener('onMessage', onMsg, this);
                await channel.addListener('onStopped', onStop, this);
                await channel.start();
                this.cntCanConnActual++;
                await this.log.info('CAN-Adapter connected: '+name);
            } catch (e) {
                await this.log.error(`Could not connect to CAN-Adapter "${name}" - err=${e.message}`);
                channel = null;
                chName  = '';
            }
        }
        return([channel, chName]);
    }

    disconnectFromCan(channel, name) {
        if (channel) {
            try {
                channel.stop();
                this.log.info('CAN-Adapter disconnected: '+name);
                channel = null;
            } catch (e) {
                this.log.error(`Could not disconnect from CAN "${name}" - err=${e.message}`);
                channel = null;
            }
        }
    }

    // Setup E380 collect worker:
    async setupE380CollectWorker(conf) {
        let e380Worker = null;
        if (conf.e380Active) {
            e380Worker = new collect.collect({
                'canID': [
                    0x250,0x251,
                    0x252,0x253,
                    0x254,0x255,
                    0x256,0x257,
                    0x258,0x259,
                    0x25A,0x25B,
                    0x25C,0x25D],
                'stateBase': conf.e380Name,
                'device': 'e380',
                'delay': conf.e380Delay,
                'active': conf.e380Active});
            await e380Worker.initStates(this,'standby');
        }
        if (e380Worker) await e380Worker.startup(this);
        return e380Worker;
    }

    // Setup E3100CB collect worker:
    async setupE3100cbCollectWorker(conf) {
        let e3100cbWorker = null;
        if (conf.e3100cbActive) {
            e3100cbWorker = new collect.collect({
                'canID': [0x569],
                'stateBase': conf.e3100cbName,
                'device': 'e3100cb',
                'delay': conf.e3100cbDelay,
                'active': conf.e3100cbActive});
            await e3100cbWorker.initStates(this,'standby');
        }
        if (e3100cbWorker) await e3100cbWorker.startup(this);
        return e3100cbWorker;
    }

    // Setup E3 collect workers:

    async setupE3CollectWorkers(conf, workers) {
        if ( (conf) && (conf.length > 0) ) {
            for (const workerConf of Object.values(conf)) {
                if (workerConf.collectActive) {
                    // @ts-ignore
                    const devInfo = this.config.tableUdsDevices.filter(item => item.collectCanId == workerConf.collectCanId);
                    if (devInfo.length > 0) {
                        const worker = new collect.collect(
                            {   'canID'    : [Number(workerConf.collectCanId)],
                                'stateBase': devInfo[0].devStateName,
                                'device'   : 'common',
                                'timeout'  : this.collectTimeout,
                                'delay'    : workerConf.collectDelayTime
                            });
                        await worker.initStates(this, 'standby');
                        if (worker) await worker.startup(this);
                        workers[Number(workerConf.collectCanId)] = worker;
                    }
                }
            }
        }
    }

    // Setup workers for collecting data and for communication via UDS

    async setupUdsWorkers() {
        // Create an UDS worker for each device
        // This is to allow writing of data points even when no schedule for reading is defined
        for (const dev of Object.values(this.config.tableUdsDevices)) {
            // @ts-ignore
            const devTxAddr = Number(dev.devAddr);
            const devRxAddr = devTxAddr + 16;
            // @ts-ignore
            this.log.silly('New UDS worker on '+String(dev.devStateName));
            this.E3UdsWorkers[devRxAddr] = new uds.uds(
                {   'canID'    : devTxAddr,
                    // @ts-ignore
                    'stateBase': dev.devStateName,
                    'device'   : 'common',
                    'delay'    : 0,
                    'active'   : false,
                    'channel'  : this.channelExt,
                    'timeout'  : this.udsTimeout
                });
            await this.E3UdsWorkers[devRxAddr].initStates(this,'standby');
        }
        // @ts-ignore
        if ( (this.config.tableUdsSchedules) && (this.config.tableUdsSchedules.length > 0) ) {
            // @ts-ignore
            for (const dev of Object.values(this.config.tableUdsSchedules)) {
                if (dev.udsScheduleActive) {
                    const devTxAddr = Number(dev.udsSelectDevAddr);
                    const devRxAddr = devTxAddr + 16;
                    await this.E3UdsWorkers[devRxAddr].addSchedule(this, dev.udsSchedule, dev.udsScheduleDids);
                    this.log.silly('New Schedule ('+String(dev.udsSchedule)+'s) UDS device on '+String(dev.udsSelectDevAddr));
                }
            }
        }
        for (const worker of Object.values(this.E3UdsWorkers)) {
            await worker.startup(this,'normal');
            this.subscribeStates(this.namespace+'.'+worker.config.stateBase+'.*',this.onStateChange);
            await this.udsScanWorker.sleep(this, this.udsTimeDelta);
        }
    }


    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            const tStart = new Date().getTime();
            this.stoppingInstance = true;
            // Stop UDS workers:
            for (const toh of Object.values(this.udsTimeoutHandles)) await this.clearTimeout(toh);
            for (const worker of Object.values(this.E3UdsWorkers)) await worker.stop(this);
            for (const worker of Object.values(this.E3UdsSID77Workers)) await worker.stop(this);
            for (const worker of Object.values(this.udsScanWorker.workers)) await worker.stop(this);

            // Stop Collect workers:
            if (this.e380Collect) await this.e380Collect.stop(this);
            if (this.e3100cbCollect) await this.e3100cbCollect.stop(this);
            for (const worker of Object.values(this.E3CollectExt)) await worker.stop(this);
            for (const worker of Object.values(this.E3CollectInt)) await worker.stop(this);

            if (this.cntWorkersActive > 0) {
                // Timeout - there are still unstopped workers
                this.log.warn('Not all workers could be stopped during onOnload(). Number of still active workers: '+String(this.cntWorkersActive));
            }

            // Stop CAN communication:
            // @ts-ignore
            this.disconnectFromCan(this.channelExt,this.config.canExtName);
            // @ts-ignore
            this.disconnectFromCan(this.channelInt,this.config.canIntName);
            this.setState('info.connection', false, true);

            this.log.debug('onUnload() took '+String(new Date().getTime()-tStart)+' ms to complete.');

            callback();
        } catch (e) {
            this.log.error('unLoad() could not be completed. err='+e.message);
            callback();
        }
    }

    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  * @param {string} id
    //  * @param {ioBroker.Object | null | undefined} obj
    //  */
    // @ts-ignore
    /*
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }
    */

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if ( (state) && (!state.ack) ) {
            // The state was changed and ack == false
            this.log.silly(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
            for (const worker of Object.values(this.E3UdsWorkers)) {
                if (id.includes(this.namespace+'.'+worker.config.stateBase)) {
                    this.log.silly(`Call worker for ${worker.config.stateBase}`);
                    worker.onUdsStateChange(this, worker, id, state);
                }
            }
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.messagebox" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    async onMessage(obj) {
        //await this.log.debug('this.config:');
        //await this.log.debug(JSON.stringify(this.config));
        if (typeof obj === 'object' && obj.message) {
            this.log.silly(`command received ${obj.command}`);

            if (obj.command === 'getUdsDevices') {
                if (obj.callback) {
                    if (!this.udsDevScanIsRunning) {
                        this.udsDevScanIsRunning = true;
                        await this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                        await this.udsScanWorker.scanUdsDevices(this);
                        await this.log.silly(`Data to send - ${JSON.stringify({native: {tableUdsDevices: this.udsDevices}})}`);
                        await this.sendTo(obj.from, obj.command, {native: {tableUdsDevices: this.udsDevices}}, obj.callback);
                        this.udsDevScanIsRunning = false;
                    } else {
                        await this.log.debug('Request "getUdsDevice" during running UDS scan!');
                        this.sendTo(obj.from, obj.command, {native: {tableUdsDevices: this.udsDevices}}, obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, {native: {tableUdsDevices: []}}, obj.callback);
                }
            }

            if (obj.command === 'getUdsDeviceSelect') {
                if (obj.callback) {
                    this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                    if (Array.isArray(obj.message) ) {
                        const selUdsDevices = obj.message.map(item => ({label: item.devStateName, value: item.devAddr}));
                        this.log.silly(`Data to send - ${JSON.stringify(selUdsDevices)}`);
                        if (selUdsDevices) {
                            this.sendTo(obj.from, obj.command, selUdsDevices, obj.callback);
                        }
                    } else {
                        this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                }
            }

            if (obj.command === 'getExtColDeviceSelect') {
                if (obj.callback) {
                    this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                    if (Array.isArray(obj.message) ) {
                        const selUdsDevices = obj.message.filter(item => item.collectCanId != '').map(item => ({label: item.devStateName, value: item.collectCanId}));
                        this.log.silly(`Data to send - ${JSON.stringify(selUdsDevices)}`);
                        if (selUdsDevices) {
                            this.sendTo(obj.from, obj.command, selUdsDevices, obj.callback);
                        }
                    } else {
                        this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                }
            }

            if (obj.command === 'getIntColDeviceSelect') {
                if (obj.callback) {
                    this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                    if (Array.isArray(obj.message) ) {
                        const selUdsDevices = obj.message.filter(item => item.collectCanId != '').map(item => ({label: item.devStateName, value: item.collectCanId}));
                        this.log.silly(`Data to send - ${JSON.stringify(selUdsDevices)}`);
                        if (selUdsDevices) {
                            this.sendTo(obj.from, obj.command, selUdsDevices, obj.callback);
                        }
                    } else {
                        this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                }
            }

            if (obj.command === 'startDidScan') {
                if (obj.callback) {
                    if (!this.udsDidScanIsRunning) {
                        this.udsDidScanIsRunning = true;
                        this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                        await this.udsScanWorker.scanUdsDids(this,this.udsDevAddrs,this.udsDidsMaxNmbr);
                        //await this.udsScanWorker.scanUdsDids(this,this.udsDevAddrs,300);
                        this.sendTo(obj.from, obj.command, this.udsDevices, obj.callback);
                        this.udsDidScanIsRunning = false;
                    } else {
                        this.log.silly('Request "startDidScan" during running UDS did scan!');
                        this.sendTo(obj.from, obj.command, obj.message, obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, obj.message, obj.callback);
                }
            }

            if (obj.command === 'getUdsDids') {
                if (obj.callback) {
                    this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                    if ( (obj.message) && (this.udsDevStateNames.includes(obj.message)) ) {
                        const udsDids = new storage.storageDids({stateBase:obj.message, device:obj.message});
                        await udsDids.readKnownDids(this);
                        const udsDidsTable = [];
                        if (udsDids.didsDevSpecAvail) {
                            for (const [did, item] of Object.entries(udsDids.didsDictDevCom)) {
                                udsDidsTable.push({didId:Number(did), didLen:Number(item.len), didName:item.id, didCodec:item.codec});
                                //if (udsDidsTable.length >= 50) break;
                            }
                            for (const [did, item] of Object.entries(udsDids.didsDictDevSpec)) {
                                udsDidsTable.push({didId:Number(did), didLen:Number(item.len), didName:item.id, didCodec:item.codec});
                                //if (udsDidsTable.length >= 60) break;
                            }
                            udsDidsTable.sort((a,b) => a.didId-b.didId);
                        }
                        this.sendTo(obj.from, obj.command, {native: {tableUdsDids: udsDidsTable}}, obj.callback);
                    } else {
                        this.sendTo(obj.from, obj.command, {native: {tableUdsDids: []}}, obj.callback);
                    }
                } else {
                    this.sendTo(obj.from, obj.command, {native: {tableUdsDids: []}}, obj.callback);
                }
            }

            if (obj.command === 'getUdsDidsDevSelect') {
                if (obj.callback) {
                    this.log.silly(`Received data - ${JSON.stringify(obj)}`);
                    // @ts-ignore
                    const selUdsDevices = this.config.tableUdsDevices.map(item => ({ label: item.devStateName, value: item.devStateName }));
                    await this.log.silly(`Data to send - ${JSON.stringify(selUdsDevices)}`);
                    if (selUdsDevices) {
                        await this.sendTo(obj.from, obj.command, selUdsDevices, obj.callback);
                    }
                } else {
                    await this.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                }
            }


        }
    }

    onCanExtStopped() {
        if (!this.stoppingInstance) {
            // External CAN connection was terminated unexpectedly
            this.log.error('External CAN bus was stopped.');
        }
        this.cntCanConnActual--;
        this.setState('info.connection', false, true);
    }

    onCanIntStopped() {
        if (!this.stoppingInstance) {
            // External CAN connection was terminated unexpectedly
            this.log.error('Internal CAN bus was stopped.');
        }
        this.cntCanConnActual--;
        this.setState('info.connection', false, true);
    }

    onCanMsgExt(msg) {
        if ( (this.e380Collect) && (this.e380Collect.config.canID.includes(msg.id)) ) { this.e380Collect.msgCollect(this, msg); }
        if ( (this.e3100cbCollect) && (this.e3100cbCollect.config.canID.includes(msg.id)) ) { this.e3100cbCollect.msgCollect(this, msg); }
        if (this.E3CollectExt[msg.id]) this.E3CollectExt[msg.id].msgCollect(this, msg);
        if (this.E3UdsWorkers[msg.id]) this.E3UdsWorkers[msg.id].msgUds(this, msg);
        if (this.E3UdsSID77Workers[msg.id]) this.E3UdsSID77Workers[msg.id].msgUds(this, msg);
        if (this.udsScanWorker.workers[msg.id]) this.udsScanWorker.workers[msg.id].msgUds(this, msg);
    }

    onCanMsgInt(msg) {
        if (this.E3CollectInt[msg.id]) this.E3CollectInt[msg.id].msgCollect(this, msg);
    }
}


if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new E3oncan(options);
} else {
    // otherwise start the instance directly
    new E3oncan();
}
