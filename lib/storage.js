
const E3              = require('./codecs');
const E3DidsDict      = require('./didsE3.json');
const E380DidsDict    = require('./didsE380.json');
const E3100CBDidsDict = require('./didsE3100CB.json');

class storageDids {
    constructor(config) {
        this.config = config;
        this.didsWritablesId = 'udsDidsWritable';
        this.didsCommonId    = 'udsDidsCommon';
        this.didsSpecId      = 'udsDidsSpecific';
        this.didsE380Id      = 'didsE380';
        this.didsE3100cbId   = 'didsE3100CB';
        this.didsWritable    = {};
        this.didsDictE3      = {};      // Common dids imported from project open3e
        this.didsDictDevCom  = {};      // Dids of this device matching the E3 common list
        this.didsDictDevSpec = {};      // Dids specific for this device
        this.dids            = {};      // Consolidated list of dids available for this device
        this.didsDevSpecAvail= false;   // true, if device specific dids are available
    }
    async initStates(ctx, opMode) {
        if (['standby','normal','udsDidScan','service77'].includes(opMode)) {
            switch (this.config.device) {
                case 'e380':
                    await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.didsE380Id, {
                        type: 'state',
                        common: {
                            name: this.config.stateBase+' all available datapoints',
                            role: 'state',
                            type: 'json',
                            read: true,
                            write: true,
                            def: JSON.stringify({})
                        },
                        native: {},
                    });
                    break;
                case 'e3100cb':
                    await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.didsE3100cbId, {
                        type: 'state',
                        common: {
                            name: this.config.stateBase+' all available datapoints',
                            role: 'state',
                            type: 'json',
                            read: true,
                            write: true,
                            def: JSON.stringify({})
                        },
                        native: {},
                    });
                    break;
                default:
                    await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.didsWritablesId, {
                        type: 'state',
                        common: {
                            name: this.config.stateBase+' list of datapoints writable via WriteByDid',
                            role: 'state',
                            type: 'json',
                            read: true,
                            write: true,
                            def: JSON.stringify({})
                        },
                        native: {},
                    });
                    await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.didsCommonId, {
                        type: 'state',
                        common: {
                            name: this.config.stateBase+' all available datapoints',
                            role: 'state',
                            type: 'json',
                            read: true,
                            write: true,
                            def: JSON.stringify({})
                        },
                        native: {},
                    });
                    await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.didsSpecId, {
                        type: 'state',
                        common: {
                            name: this.config.stateBase+' available datapoints specific to this device',
                            role: 'state',
                            type: 'json',
                            read: true,
                            write: true,
                            def: JSON.stringify({})
                        },
                        native: {},
                    });
            }
        }
    }
    async mergeDids(didsCommon, didsDevSpecific) {
        const dids = await JSON.parse(JSON.stringify(didsCommon));
        for (const [id, did] of Object.entries(didsDevSpecific)) {
            if (id != 'Version') dids[id] = did;
        }
        return(dids);
    }
    async readKnownDids(ctx, opMode) {
        // Read common and devive specific dids list known from dids scan
        // If scanned dids are avalilable: return complete list of dids for this device
        // else return list of common dids for all devices and list of writable dids
        switch (this.config.device) {
            case 'e380':
                try {
                    const baseId = this.config.stateBase+'.info.';
                    this.didsWritable    = {};
                    this.didsDictDevCom  = await JSON.parse((await ctx.getStateAsync(baseId+this.didsE380Id)).val);
                    this.didsDictDevSpec = {};
                } catch(e) {
                    this.didsWritable    = {};
                    this.didsDictDevCom  = JSON.parse(JSON.stringify(E380DidsDict));
                    this.didsDictDevSpec = {};
                }
                if (Object.keys(this.didsDictDevCom).length == 0) {
                    // No dids scan results available yet
                    this.didsDictDevCom  = JSON.parse(JSON.stringify(E380DidsDict));
                    this.didsDictDevCom.Version = '20240218';       // First available version
                }
                if (this.didsDictDevCom.Version < '20240320') {
                    // Add data points for E380 on CAN address=98 (available since version 20240320):
                    ctx.log.info('Adding support for energy meter E380 with CAN-address=98');
                    this.didsDictDevCom = await this.mergeDids(this.didsDictDevCom,E380DidsDict);
                }
                this.didsDevSpecAvail = true;                       // Dids are available even on first start
                this.dids = await this.mergeDids(this.didsDictDevCom,this.didsDictDevSpec);
                break;
            case 'e3100cb':
                try {
                    const baseId = this.config.stateBase+'.info.';
                    this.didsWritable    = {};
                    this.didsDictDevCom  = await JSON.parse((await ctx.getStateAsync(baseId+this.didsE3100cbId)).val);
                    this.didsDictDevSpec = {};
                } catch(e) {
                    this.didsWritable    = {};
                    this.didsDictDevCom  = JSON.parse(JSON.stringify(E3100CBDidsDict));
                    this.didsDictDevSpec = {};
                }
                if (Object.keys(this.didsDictDevCom).length == 0) {
                    // No dids scan results available yet
                    this.didsDictDevCom  = JSON.parse(JSON.stringify(E3100CBDidsDict));
                }
                this.didsDevSpecAvail = true;                       // Dids are available even on first start
                this.dids = await this.mergeDids(this.didsDictDevCom,this.didsDictDevSpec);
                break;
            default:
                if (opMode != 'udsDevScan') {
                    try {
                        const baseId = this.config.stateBase+'.info.';
                        this.didsWritable    = await JSON.parse((await ctx.getStateAsync(baseId+this.didsWritablesId)).val);
                        this.didsDictDevCom  = await JSON.parse((await ctx.getStateAsync(baseId+this.didsCommonId)).val);
                        this.didsDictDevSpec = await JSON.parse((await ctx.getStateAsync(baseId+this.didsSpecId)).val);
                        this.didsDevSpecAvail= true;
                    } catch(e) {
                        // Device specific data not available yet
                        this.didsWritable    = {};
                        this.didsDictDevCom  = E3DidsDict;
                        this.didsDictDevSpec = {};
                        this.didsDevSpecAvail= false;
                    }
                    if (Object.keys(this.didsDictDevCom).length == 0) {
                        // No dids scan results available yet
                        this.didsDictDevCom  = E3DidsDict;
                    }
                } else {
                    // UDS device scan
                    this.didsWritable    = {};
                    this.didsDictDevCom[ctx.udsDidForScan]  = E3DidsDict[ctx.udsDidForScan];
                    this.didsDictDevSpec = {};
                }
                if (opMode == 'udsDidScan') {
                    this.didsDictDevCom  = {};
                    this.dids = E3DidsDict;
                } else {
                    this.dids = await this.mergeDids(this.didsDictDevCom,this.didsDictDevSpec);
                }
        }
    }
    async storeKnownDids(ctx) {
        const baseId = this.config.stateBase+'.info.';
        switch (this.config.device) {
            case 'e380':
                await ctx.setStateAsync(baseId+this.didsE380Id, {val: JSON.stringify(this.didsDictDevCom), ack: true});
                break;
            case 'e3100cb':
                await ctx.setStateAsync(baseId+this.didsE3100cbId, {val: JSON.stringify(this.didsDictDevCom), ack: true});
                break;
            default:
                await ctx.setStateAsync(baseId+this.didsWritablesId, {val: JSON.stringify(this.didsWritable), ack: true});
                await ctx.setStateAsync(baseId+this.didsCommonId, {val: JSON.stringify(this.didsDictDevCom), ack: true});
                await ctx.setStateAsync(baseId+this.didsSpecId, {val: JSON.stringify(this.didsDictDevSpec), ack: true});
        }
    }
    toHex(d) {
        // Convert integer to hex string of length len
        return ('00'+(Number(d).toString(16))).slice(-2);
    }

    arr2Hex(arr) {
        // Convert byte array to hex string
        let hs = '';
        for (const v in arr) { hs += this.toHex(arr[v]); }
        return hs;
    }

    toByteArray(hs) {
        // Convert hex string, e.g. '21A8' to byte array: [33,168]
        const ba = [];
        for (let i=0; i<hs.length/2; i++) {
            ba.push(parseInt(hs.slice(2*i,2*i+2), 16));
        }
        return ba;
    }
    getDidStr(did) {
        let didStr = '';
        if (this.config.device == 'e3100cb') {
            didStr = String(did);
        } else {
            didStr = '000'+String(did);
            didStr = didStr.slice(-4);
        }
        return didStr;
    }
    async getDidStruct(ctx, didStruct, obj) {
        try {
            if (typeof(obj) == 'object') {
                if (obj.codec) await didStruct.push([obj.codec,obj.len]);
                if (Object.keys(obj).length <= 100) {
                    for (const itm of Object.values(obj)) {
                        if (itm.codec) await didStruct.push([itm.codec,itm.len]);
                        await this.getDidStruct(ctx, didStruct,itm);
                    }
                } else {
                    ctx.log.error('Did valuation aborted. Too many members ('+String(Object.keys(obj).length)+')');
                }
            }
            return didStruct;
        } catch(e) {
            ctx.log.error('Evaluation of did '+JSON.stringify(didStruct)+' failed. err='+e.message);
        }
    }
    async getObjectVal(ctx, stateId) {
        let val = null;
        try {
            val = await JSON.parse((await ctx.getStateAsync(stateId)).val);
        }
        catch(e) {
            ctx.log.silly('Reading of did '+stateId+' failed. err='+e.message);
        }
        return val;
    }
    async storeObject(ctx, did, idStr, stateId, obj, type, role, forceExtendObject=false) {
        try {
            if (forceExtendObject) {
                // Override object properties, e.g. data type
                await ctx.extendObject(stateId, {
                    type: 'state',
                    common: {
                        name: idStr,
                        type: type,
                        role: role,
                        read: true,
                        write: true,
                    },
                    native: {},
                });
            } else {
                await ctx.setObjectNotExistsAsync(stateId, {
                    type: 'state',
                    common: {
                        name: idStr,
                        type: type,
                        role: role,
                        read: true,
                        write: true,
                    },
                    native: {},
                });
            }
            if (type == 'number') {
                await ctx.setStateAsync(stateId, obj, true);
            } else {
                await ctx.setStateAsync(stateId, JSON.stringify(obj), true);
            }
        }
        catch(e) {
            ctx.log.error('Storing of did '+stateId+'.'+String(did)+' failed. err='+e.message);
        }
    }
    async storeObjectJson(ctx, did, idStr, stateId, obj) {
        await this.storeObject(ctx, did, idStr, stateId, obj, 'string', 'json');
    }
    async storeObjectTree(ctx, did, idStr, stateId, obj, forceExtendObject=false) {
        if (typeof(obj) == 'object') {
            if (Object.keys(obj).length <= 100) {
                for (const [key, itm] of Object.entries(obj)) {
                    await this.storeObjectTree(ctx, did, idStr, String(stateId)+'.'+String(key).replace(ctx.FORBIDDEN_CHARS,'_').replace('.','_'),itm, forceExtendObject);
                    // No FORBIDDEN_CHARS and no '.' in state id allowed
                }
            } else {
                ctx.log.error('Did valuation aborted. Too many members ('+String(Object.keys(obj).length)+') '+stateId+'.'+String(did));
            }
        } else {
            const type = (typeof obj === 'number' ? 'number' : 'string');
            await this.storeObject(ctx, did, idStr, stateId, obj, type, 'state', forceExtendObject);
        }
    }
    async decodeDid(ctx, stateBase, did, cdi, data) {
        let codec;
        const res = {};
        try {
            codec = await new E3.O3Ecodecs[cdi.codec](cdi.len, cdi.id, cdi.args);
        } catch(e) {
            ctx.log.warn('Could not retreive codec for '+stateBase+'.'+String(did)+'. err='+e.message);
            codec = 'RawCodec';
        }
        // No FORBIDDEN_CHARS and no '.' in state allowed:
        res.idStr = cdi.id.replace(ctx.FORBIDDEN_CHARS,'_').replace('.','_');
        try {
            res.val = await codec.decode(data);
        } catch(e) {
            res.val = this.arr2Hex(data);
            ctx.log.warn('Codec failed: '+stateBase+'.'+String(did)+'. err='+e.message);
        }
        return res;
    }
}

class storage {
    constructor(config) {
        this.config = config;
        this.storageDids   = new storageDids({
            stateBase:this.config.stateBase,
            device:this.config.device
        });
        this.opModes = ['standby','udsDevScan','udsDidScan','normal','TEST','service77'];
        this.opMode = this.opModes[0];
        this.udsScanResult = null;
    }
    async initStates(ctx, opMode) {
        await this.setOpMode(opMode);
        if (opMode != 'udsDevScan') {
            await ctx.setObjectNotExistsAsync(this.config.stateBase, {
                type: 'device',
                common: {
                    name: this.config.stateBase,
                },
                native: {},
            });

            await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info', {
                type: 'channel',
                common: {
                    name: this.config.stateBase+' informations',
                },
                native: {},
            });

            await ctx.setObjectNotExistsAsync(this.config.stateBase+'.info.'+this.config.statId, {
                type: 'state',
                common: {
                    name: this.config.stateBase+' statistics about communication',
                    role: 'info.status',
                    type: 'json',
                    read: true,
                    write: true,
                    def: JSON.stringify({})
                },
                native: {},
            });

            await this.storageDids.initStates(ctx, opMode);

            if (opMode != 'service77') {
                await ctx.setObjectNotExistsAsync(this.config.stateBase+'.json', {
                    type: 'channel',
                    common: {
                        name: this.config.stateBase+' JSON',
                    },
                    native: {},
                });

                await ctx.setObjectNotExistsAsync(this.config.stateBase+'.tree', {
                    type: 'channel',
                    common: {
                        name: this.config.stateBase+' TREE',
                    },
                    native: {},
                });

                await ctx.setObjectNotExistsAsync(this.config.stateBase+'.raw', {
                    type: 'channel',
                    common: {
                        name: this.config.stateBase+' RAW',
                    },
                    native: {},
                });
            }
        }
        await this.storageDids.readKnownDids(ctx, opMode);
    }

    async setOpMode(mode) {
        if (this.opModes.includes(mode)) {
            this.opMode = mode;
        }
    }

    async getOpMode() {
        return(this.opMode);
    }

    async storeStatistics(ctx, ctxWorker, forceStore) {
        if (['standby','normal','udsDidScan','service77'].includes(await this.getOpMode())) {
            const ts = new Date().getTime();
            if ( (!forceStore) && (ts < ctxWorker.stat.nextTs) ) return;     // Min. time step not reached. Do not store.
            if (ctxWorker.stat) ctx.setStateAsync(ctxWorker.config.stateBase+'.info.'+this.config.statId, JSON.stringify(ctxWorker.stat), true);
            ctxWorker.stat.nextTs = ts+ctxWorker.stat.tsMinStep;
        }
    }

    async encodeDataCAN(ctx, ctxWorker, did, data) {
        // Encode data for given did
        let val;
        if (did in this.storageDids.dids) {
            const cdi = this.storageDids.dids[did];     // Infos about did codec
            try {
                const codec = await new E3.O3Ecodecs[cdi.codec](cdi.len, cdi.id, cdi.args);
                val = await codec.encode(data);
            } catch(e) {
                await ctx.log.warn('encodeDataCAN(): Could not encode data for '+ctxWorker.config.stateBase+'.'+String(did)+'. err='+e.message);
                val = null;
            }
        } else {
            await ctx.log.warn('encodeDataCAN(): Did not found for '+ctxWorker.config.stateBase+'.'+String(did));
            val = null;
        }
        return(val);
    }

    async decodeDataCAN(ctx, ctxWorker, did, data) {
        if (this.opMode == this.opModes[0]) { return; }
        const raw = this.storageDids.arr2Hex(data);
        let idStr, val, common, cdi;
        if (did in this.storageDids.dids) {
            cdi = this.storageDids.dids[did];     // Infos about did codec
            if (cdi.len == data.length) {
                const res = await this.storageDids.decodeDid(ctx, ctxWorker.config.stateBase, did, cdi, data);
                idStr  = res.idStr;
                val    = res.val;
                common = true;
            } else {
                // did length is diffetent from common did length => device specific did
                idStr = 'DeviceSpecific';
                val = raw;
                common = false;
            }
        } else {
            idStr = 'DeviceSpecific';
            val = raw;
            common = false;
        }
        if (val != null) {
            const didStr = this.storageDids.getDidStr(did);
            const stateIdJson = this.config.stateBase+'.json.'+didStr+'_'+idStr;
            const stateIdTree = this.config.stateBase+'.tree.'+didStr+'_'+idStr;
            const stateIdRaw = this.config.stateBase+'.raw.'+didStr+'_'+idStr;
            let didInfo;
            switch (this.opMode) {
                case this.opModes[0]:   // 'standby'
                    break;
                case this.opModes[1]:   // 'udsDevScan'
                    this.udsScanResult = {
                        did: did,
                        didInfo: {
                            id : idStr,
                            len: data.length
                        },
                        val: val,
                        common: common
                    };
                    if (ctxWorker.callback) await ctxWorker.callback(ctx, ctxWorker, ['ok', this.udsScanResult]);
                    break;
                case this.opModes[2]:   // 'udsDidScan'
                    if (common) {
                        didInfo = {
                            id : idStr,
                            len: cdi.len,
                            codec: cdi.codec,
                            args: cdi.args
                        };
                    } else {
                        didInfo = {
                            id : idStr,
                            len: data.length,
                            codec: 'RawCodec',
                            args : {}
                        };
                    }
                    this.udsScanResult = {
                        did: did,
                        didInfo: didInfo,
                        val: val,
                        common: common
                    };
                    if (ctxWorker.callback) await ctxWorker.callback(ctx, ctxWorker, ['ok', this.udsScanResult]);
                    await this.storageDids.storeObjectTree(ctx, did, idStr, stateIdTree, val);
                    await this.storageDids.storeObjectJson(ctx, did, idStr, stateIdJson, val);
                    await this.storageDids.storeObjectJson(ctx, did, idStr, stateIdRaw, raw);
                    await this.storeStatistics(ctx, ctxWorker, false);
                    break;
                case this.opModes[3]:   // 'normal'
                    await this.storageDids.storeObjectTree(ctx, did, idStr, stateIdTree, val);
                    await this.storageDids.storeObjectJson(ctx, did, idStr, stateIdJson, val);
                    await this.storageDids.storeObjectJson(ctx, did, idStr, stateIdRaw, raw);
                    await this.storeStatistics(ctx, ctxWorker, false);
                    break;
                case this.opModes[4]:   // 'TEST'
                    return val;
                case this.opModes[5]:   // 'service77' - user specific mode for writeDataByIdentifier
                    await this.storeStatistics(ctx, ctxWorker, true);
                    break;
                default:
                    ctx.log.error('Invalid opMode at class storage. Change to "standby"');
                    this.opMode = this.opModes[0];
            }
        }
    }
}

module.exports = {
    storageDids,
    storage
};