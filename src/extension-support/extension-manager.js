const dispatch = require('../dispatch/central-dispatch');
const log = require('../util/log');

const BlockType = require('./block-type');

// These extensions are currently built into the VM repository but should not be loaded at startup.
// TODO: move these out into a separate repository?
// TODO: change extension spec so that library info, including extension ID, can be collected through static methods
const Scratch3PenBlocks = require('../blocks/scratch3_pen');
const Scratch3WeDo2Blocks = require('../blocks/scratch3_wedo2');
const builtinExtensions = {
    pen: Scratch3PenBlocks,
    wedo2: Scratch3WeDo2Blocks
};

/**
 * @typedef {object} ArgumentInfo - Information about an extension block argument
 * @property {ArgumentType} type - the type of value this argument can take
 * @property {*|undefined} default - the default value of this argument (default: blank)
 */

/**
 * @typedef {object} BlockInfo - Information about an extension block
 * @property {string} opcode - the block opcode
 * @property {string|object} text - the human-readable text on this block
 * @property {BlockType|undefined} blockType - the type of block (default: BlockType.COMMAND)
 * @property {int|undefined} branchCount - the number of branches this block controls, if conditional (default: 0)
 * @property {Boolean|undefined} isTerminal - true if this block ends a stack (default: false)
 * @property {Boolean|undefined} blockAllThreads - true if all threads must wait for this block to run (default: false)
 * @property {object.<string,ArgumentInfo>|undefined} arguments - information about this block's arguments, if any
 * @property {string|Function|undefined} func - the method for this block on the extension service (default: opcode)
 * @property {Array.<string>|undefined} filter - the list of targets for which this block should appear (default: all)
 */

/**
 * @typedef {object} CategoryInfo - Information about a block category
 * @property {string} id - the unique ID of this category
 * @property {string} color1 - the primary color for this category, in '#rrggbb' format
 * @property {string} color2 - the secondary color for this category, in '#rrggbb' format
 * @property {string} color3 - the tertiary color for this category, in '#rrggbb' format
 * @property {Array.<BlockInfo>} block - the blocks in this category
 */

/**
 * @typedef {object} PendingExtensionWorker - Information about an extension worker still initializing
 * @property {string} extensionURL - the URL of the extension to be loaded by this worker
 * @property {Function} resolve - function to call on successful worker startup
 * @property {Function} reject - function to call on failed worker startup
 */

class ExtensionManager {
    constructor (runtime) {
        /**
         * The ID number to provide to the next extension worker.
         * @type {int}
         */
        this.nextExtensionWorker = 0;

        /**
         * FIFO queue of extensions which have been requested but not yet loaded in a worker,
         * along with promise resolution functions to call once the worker is ready or failed.
         *
         * @type {Array.<PendingExtensionWorker>}
         */
        this.pendingExtensions = [];

        /**
         * Map of worker ID to workers which have been allocated but have not yet finished initialization.
         * @type {Array.<PendingExtensionWorker>}
         */
        this.pendingWorkers = [];

        /**
         * Keep a reference to the runtime so we can construct internal extension objects.
         * TODO: remove this in favor of extensions accessing the runtime as a service.
         * @type {Runtime}
         */
        this.runtime = runtime;

        dispatch.setService('extensions', this).catch(e => {
            log.error(`ExtensionManager was unable to register extension service: ${JSON.stringify(e)}`);
        });
    }

    /**
     * Load an extension by URL or internal extension ID
     * @param {string} extensionURL - the URL for the extension to load OR the ID of an internal extension
     * @returns {Promise} resolved once the extension is loaded and initialized or rejected on failure
     */
    loadExtensionURL (extensionURL) {
        if (builtinExtensions.hasOwnProperty(extensionURL)) {
            const extension = builtinExtensions[extensionURL];
            const extensionInstance = new extension(this.runtime);
            return this._registerInternalExtension(extensionInstance);
        }

        return new Promise((resolve, reject) => {
            // If we `require` this at the global level it breaks non-webpack targets, including tests
            const ExtensionWorker = require('worker-loader?name=extension-worker.js!./extension-worker');

            this.pendingExtensions.push({extensionURL, resolve, reject});
            dispatch.addWorker(new ExtensionWorker());
        });
    }

    allocateWorker () {
        const id = this.nextExtensionWorker++;
        const workerInfo = this.pendingExtensions.shift();
        this.pendingWorkers[id] = workerInfo;
        return [id, workerInfo.extensionURL];
    }

    registerExtensionService (serviceName) {
        dispatch.call(serviceName, 'getInfo').then(info => {
            this._registerExtensionInfo(serviceName, info);
        });
    }

    onWorkerInit (id, e) {
        const workerInfo = this.pendingWorkers[id];
        delete this.pendingWorkers[id];
        if (e) {
            workerInfo.reject(e);
        } else {
            workerInfo.resolve(id);
        }
    }

    /**
     * Register an internal (non-Worker) extension object
     * @param {object} extensionObject - the extension object to register
     * @returns {Promise} resolved once the extension is fully registered or rejected on failure
     */
    _registerInternalExtension (extensionObject) {
        const extensionInfo = extensionObject.getInfo();
        const serviceName = `extension.internal.${extensionInfo.id}`;
        return dispatch.setService(serviceName, extensionObject)
            .then(() => dispatch.call('extensions', 'registerExtensionService', serviceName));
    }

    _registerExtensionInfo (serviceName, extensionInfo) {
        extensionInfo = this._prepareExtensionInfo(serviceName, extensionInfo);
        dispatch.call('runtime', '_registerExtensionPrimitives', extensionInfo).catch(e => {
            log.error(`Failed to register primitives for extension on service ${serviceName}: ${JSON.stringify(e)}`);
        });
    }

    /**
     * Modify the provided text as necessary to ensure that it may be used as an attribute value in valid XML.
     * @param {string} text - the text to be sanitized
     * @returns {string} - the sanitized text
     * @private
     */
    _sanitizeID (text) {
        return text.toString().replace(/[<"&]/, '_');
    }

    /**
     * Apply minor cleanup and defaults for optional extension fields.
     * TODO: make the ID unique in cases where two copies of the same extension are loaded.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @param {ExtensionInfo} extensionInfo - the extension info to be sanitized
     * @returns {ExtensionInfo} - a new extension info object with cleaned-up values
     * @private
     */
    _prepareExtensionInfo (serviceName, extensionInfo) {
        extensionInfo = Object.assign({}, extensionInfo);
        extensionInfo.id = this._sanitizeID(extensionInfo.id);
        extensionInfo.name = extensionInfo.name || extensionInfo.id;
        extensionInfo.blocks = extensionInfo.blocks || [];
        extensionInfo.targetTypes = extensionInfo.targetTypes || [];
        extensionInfo.blocks = extensionInfo.blocks.reduce((result, blockInfo) => {
            try {
                result.push(this._prepareBlockInfo(serviceName, blockInfo));
            } catch (e) {
                // TODO: more meaningful error reporting
                log.error(`Error processing block: ${e.message}, Block:\n${JSON.stringify(blockInfo)}`);
            }
            return result;
        }, []);
        return extensionInfo;
    }

    /**
     * Apply defaults for optional block fields.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @param {BlockInfo} blockInfo - the block info from the extension
     * @returns {BlockInfo} - a new block info object which has values for all relevant optional fields.
     * @private
     */
    _prepareBlockInfo (serviceName, blockInfo) {
        blockInfo = Object.assign({}, {
            blockType: BlockType.COMMAND,
            terminal: false,
            blockAllThreads: false,
            arguments: {}
        }, blockInfo);
        blockInfo.opcode = this._sanitizeID(blockInfo.opcode);
        blockInfo.func = blockInfo.func ? this._sanitizeID(blockInfo.func) : blockInfo.opcode;
        blockInfo.text = blockInfo.text || blockInfo.opcode;

        /**
         * This is only here because the VM performs poorly when blocks return promises.
         * @TODO make it possible for the VM to resolve a promise and continue during the same frame.
         */
        if (dispatch._isRemoteService(serviceName)) {
            blockInfo.func = dispatch.call.bind(dispatch, serviceName, blockInfo.func);
        } else {
            const serviceObject = dispatch.services[serviceName];
            blockInfo.func = serviceObject[blockInfo.func].bind(serviceObject);
        }
        return blockInfo;
    }
}

module.exports = ExtensionManager;
