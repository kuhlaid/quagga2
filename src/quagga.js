import TypeDefs from './common/typedefs'; // eslint-disable-line no-unused-vars
import ImageWrapper from './common/image_wrapper';
import BarcodeLocator from './locator/barcode_locator';
import BarcodeDecoder from './decoder/barcode_decoder';
import BarcodeReader from './reader/barcode_reader';
import Events from './common/events';
import CameraAccess from './input/camera_access';
import ImageDebug from './common/image_debug';
import ResultCollector from './analytics/result_collector';
import Config from './config/config';
import BrowserInputStream, { NodeInputStream } from './input/input_stream';
import BrowserFrameGrabber, { NodeFrameGrabber } from './input/frame_grabber';
import { merge } from 'lodash';
import { clone } from 'gl-vec2';
import { QuaggaContext } from './QuaggaContext';

import setupInputStream from './quagga/setupInputStream.ts';
import _getViewPort from './quagga/getViewPort.ts';
import _initBuffers from './quagga/initBuffers.ts';
import _initCanvas from './quagga/initCanvas';
import { moveBox, moveLine } from './quagga/transform';

const vec2 = { clone };

const InputStream = typeof window === 'undefined' ? NodeInputStream : BrowserInputStream;
const FrameGrabber = typeof window === 'undefined' ? NodeFrameGrabber : BrowserFrameGrabber;

// export BarcodeReader and other utilities for external plugins
export { BarcodeReader, BarcodeDecoder, ImageWrapper, ImageDebug, ResultCollector, CameraAccess };

const _context = new QuaggaContext();

function initBuffers(imageWrapper) {
    const { inputImageWrapper, boxSize } = _initBuffers(_context._inputStream, imageWrapper, _context._config.locator);
    _context._inputImageWrapper = inputImageWrapper;
    _context._boxSize = boxSize;
}

function initializeData(imageWrapper) {
    initBuffers(imageWrapper);
    _context.decoder = BarcodeDecoder.create(_context.config.decoder, _context.inputImageWrapper);
}

function getViewPort() {
    const { target } = _context._config.inputStream;
    return _getViewPort(target);
}

function ready(cb) {
    _context._inputStream.play();
    cb();
}

function initCanvas() {
    _initCanvas(getViewPort(), _context._canvasContainer, _context._config.inputStream.type, _context._inputStream);
}

function canRecord(cb) {
    BarcodeLocator.checkImageConstraints(_context.inputStream, _context.config.locator);
    initCanvas(_context.config);
    _context.framegrabber = FrameGrabber.create(_context.inputStream, _context.canvasContainer.dom.image);

    adjustWorkerPool(_context._config.numOfWorkers, function () {
        if (_context._config.numOfWorkers === 0) {
            initializeData();
        }
        ready(cb);
    });
}

function initInputStream(cb) {
    const { type: inputType, constraints } = _context._config.inputStream;
    const { video, inputStream } = setupInputStream(inputType, getViewPort(), InputStream);

    if (inputType === 'LiveStream') {
        CameraAccess.request(video, constraints)
            .then(() => inputStream.trigger('canrecord'))
            .catch((err) => cb(err));
    }

    inputStream.setAttribute('preload', 'auto');
    inputStream.setInputStream(_context._config.inputStream);
    inputStream.addEventListener('canrecord', canRecord.bind(undefined, cb));

    _context._inputStream = inputStream;
}

function getBoundingBoxes() {
    if (_context.config.locate) {
        return BarcodeLocator.locate();
    } else {
        return [[
            vec2.clone(_context.boxSize[0]),
            vec2.clone(_context.boxSize[1]),
            vec2.clone(_context.boxSize[2]),
            vec2.clone(_context.boxSize[3])]];
    }
}

function transformResult(result) {
    const topRight = _context._inputStream.getTopRight();
    const xOffset = topRight.x;
    const yOffset = topRight.y;

    if (xOffset === 0 && yOffset === 0) {
        return;
    }

    if (result.barcodes) {
        result.barcodes.forEach((barcode) => transformResult(barcode));
    }

    if (result.line && result.line.length === 2) {
        moveLine(result.line, xOffset, yOffset);
    }

    if (result.box) {
        moveBox(result.box, xOffset, yOffset);
    }

    if (result.boxes && result.boxes.length > 0) {
        for (let i = 0; i < result.boxes.length; i++) {
            moveBox(result.boxes[i], xOffset, yOffset);
        }
    }
}

function addResult (result, imageData) {
    if (!imageData || !_context.resultCollector) {
        return;
    }

    if (result.barcodes) {
        result.barcodes.filter(barcode => barcode.codeResult)
            .forEach(barcode => addResult(barcode, imageData));
    } else if (result.codeResult) {
        _context.resultCollector.addResult(imageData, _context.inputStream.getCanvasSize(), result.codeResult);
    }
}

function hasCodeResult (result) {
    return result && (result.barcodes ?
        result.barcodes.some(barcode => barcode.codeResult) :
        result.codeResult);
}

function publishResult(result, imageData) {
    let resultToPublish = result;

    if (result && _context.onUIThread) {
        transformResult(result);
        addResult(result, imageData);
        resultToPublish = result.barcodes || result;
    }

    Events.publish('processed', resultToPublish);
    if (hasCodeResult(result)) {
        Events.publish('detected', resultToPublish);
    }
}

function locateAndDecode() {
    const boxes = getBoundingBoxes();

    if (boxes) {
        const decodeResult = _context.decoder.decodeFromBoundingBoxes(boxes) || {};
        decodeResult.boxes = boxes;
        publishResult(decodeResult, _context.inputImageWrapper.data);
    } else {
        const imageResult = _context.decoder.decodeFromImage(_context.inputImageWrapper);
        if (imageResult) {
            publishResult(imageResult, _context.inputImageWrapper.data);
        } else {
            publishResult();
        }
    }
}

function update() {
    var availableWorker;

    if (_context.onUIThread) {
        if (_context.workerPool.length > 0) {
            availableWorker = _context.workerPool.filter(function(workerThread) {
                return !workerThread.busy;
            })[0];
            if (availableWorker) {
                _context.framegrabber.attachData(availableWorker.imageData);
            } else {
                return; // all workers are busy
            }
        } else {
            _context.framegrabber.attachData(_context.inputImageWrapper.data);
        }
        if (_context.framegrabber.grab()) {
            if (availableWorker) {
                availableWorker.busy = true;
                availableWorker.worker.postMessage({
                    cmd: 'process',
                    imageData: availableWorker.imageData,
                }, [availableWorker.imageData.buffer]);
            } else {
                locateAndDecode();
            }
        }
    } else {
        locateAndDecode();
    }
}

function startContinuousUpdate() {
    var next = null,
        delay = 1000 / (_context.config.frequency || 60);

    _context.stopped = false;
    (function frame(timestamp) {
        next = next || timestamp;
        if (!_context.stopped) {
            if (timestamp >= next) {
                next += delay;
                update();
            }
            window.requestAnimFrame(frame);
        }
    }(performance.now()));
}

function start() {
    if (_context.onUIThread && _context.config.inputStream.type === 'LiveStream') {
        startContinuousUpdate();
    } else {
        update();
    }
}

function initWorker(cb) {
    var blobURL,
        workerThread = {
            worker: undefined,
            imageData: new Uint8Array(_context.inputStream.getWidth() * _context.inputStream.getHeight()),
            busy: true,
        };

    blobURL = generateWorkerBlob();
    workerThread.worker = new Worker(blobURL);

    workerThread.worker.onmessage = function(e) {
        if (e.data.event === 'initialized') {
            URL.revokeObjectURL(blobURL);
            workerThread.busy = false;
            workerThread.imageData = new Uint8Array(e.data.imageData);
            if (ENV.development) {
                console.log('Worker initialized');
            }
            cb(workerThread);
        } else if (e.data.event === 'processed') {
            workerThread.imageData = new Uint8Array(e.data.imageData);
            workerThread.busy = false;
            publishResult(e.data.result, workerThread.imageData);
        } else if (e.data.event === 'error') {
            if (ENV.development) {
                console.log('Worker error: ' + e.data.message);
            }
        }
    };

    workerThread.worker.postMessage({
        cmd: 'init',
        size: {x: _context.inputStream.getWidth(), y: _context.inputStream.getHeight()},
        imageData: workerThread.imageData,
        config: configForWorker(_context.config),
    }, [workerThread.imageData.buffer]);
}

function configForWorker(config) {
    return {
        ...config,
        inputStream: {
            ...config.inputStream,
            target: null,
        },
    };
}

function workerInterface(factory) {
    if (factory) {
        var Quagga = factory().default;
        if (!Quagga) {
            self.postMessage({'event': 'error', message: 'Quagga could not be created'});
            return;
        }
    }
    var imageWrapper;

    function onProcessed(result) {
        self.postMessage({
            'event': 'processed',
            imageData: imageWrapper.data,
            result: result,
        }, [imageWrapper.data.buffer]);
    }

    function workerInterfaceReady() {
        self.postMessage({
            'event': 'initialized',
            imageData: imageWrapper.data,
        }, [imageWrapper.data.buffer]);
    }

    self.onmessage = function(e) {
        if (e.data.cmd === 'init') {
            var config = e.data.config;
            config.numOfWorkers = 0;
            imageWrapper = new Quagga.ImageWrapper({
                x: e.data.size.x,
                y: e.data.size.y,
            }, new Uint8Array(e.data.imageData));
            Quagga.init(config, workerInterfaceReady, imageWrapper);
            Quagga.onProcessed(onProcessed);
        } else if (e.data.cmd === 'process') {
            imageWrapper.data = new Uint8Array(e.data.imageData);
            Quagga.start();
        } else if (e.data.cmd === 'setReaders') {
            Quagga.setReaders(e.data.readers);
        } else if (e.data.cmd === 'registerReader') {
            Quagga.registerReader(e.data.name, e.data.reader);
        }
    };
}

function generateWorkerBlob() {
    var blob,
        factorySource;

    /* jshint ignore:start */
    if (typeof __factorySource__ !== 'undefined') {
        factorySource = __factorySource__; // eslint-disable-line no-undef
    }
    /* jshint ignore:end */

    blob = new Blob(['(' + workerInterface.toString() + ')(' + factorySource + ');'],
        {type: 'text/javascript'});

    return window.URL.createObjectURL(blob);
}

function setReaders(readers) {
    if (_context.decoder) {
        _context.decoder.setReaders(readers);
    } else if (_context.onUIThread && _context.workerPool.length > 0) {
        _context.workerPool.forEach(function(workerThread) {
            workerThread.worker.postMessage({cmd: 'setReaders', readers: readers});
        });
    }
}

function registerReader(name, reader) {
    // load it to the module
    BarcodeDecoder.registerReader(name, reader);
    // then make sure any running instances of decoder and workers know about it
    if (_context.decoder) {
        _context.decoder.registerReader(name, reader);
    } else if (_context.onUIThread && _context.workerPool.length > 0) {
        _context.workerPool.forEach(function(workerThread) {
            workerThread.worker.postMessage({ cmd: 'registerReader', name, reader });
        });
    }
}

function adjustWorkerPool(capacity, cb) {
    const increaseBy = capacity - _context.workerPool.length;
    if (increaseBy === 0 && cb) {
        cb();
    } else if (increaseBy < 0) {
        const workersToTerminate = _context.workerPool.slice(increaseBy);
        workersToTerminate.forEach(function(workerThread) {
            workerThread.worker.terminate();
            if (ENV.development) {
                console.log('Worker terminated!');
            }
        });
        _context.workerPool = _context.workerPool.slice(0, increaseBy);
        if (cb) {
            cb();
        }
    } else {
        const workerInitialized = (workerThread) => {
            _context.workerPool.push(workerThread);
            if (_context.workerPool.length >= capacity && cb) {
                cb();
            }
        };

        for (var i = 0; i < increaseBy; i++) {
            initWorker(workerInitialized);
        }
    }
}

export default {
    init: function(config, cb, imageWrapper) {
        _context.config = merge({}, Config, config);
        // TODO: pending restructure in Issue #105, we are temp disabling workers
        if (_context.config.numOfWorkers > 0) {
            _context.config.numOfWorkers = 0;
        }
        if (imageWrapper) {
            _context.onUIThread = false;
            initializeData(imageWrapper);
            if (cb) {
                cb();
            }
        } else {
            initInputStream(cb);
        }
    },
    start: function() {
        start();
    },
    stop: function() {
        _context.stopped = true;
        adjustWorkerPool(0);
        if (_context.config.inputStream && _context.config.inputStream.type === 'LiveStream') {
            CameraAccess.release();
            _context.inputStream.clearEventHandlers();
        }
    },
    pause: function() {
        _context.stopped = true;
    },
    onDetected: function(callback) {
        Events.subscribe('detected', callback);
    },
    offDetected: function(callback) {
        Events.unsubscribe('detected', callback);
    },
    onProcessed: function(callback) {
        Events.subscribe('processed', callback);
    },
    offProcessed: function(callback) {
        Events.unsubscribe('processed', callback);
    },
    setReaders: function(readers) {
        setReaders(readers);
    },
    registerReader: function(name, reader) {
        registerReader(name, reader);
    },
    registerResultCollector: function(resultCollector) {
        if (resultCollector && typeof resultCollector.addResult === 'function') {
            _context.resultCollector = resultCollector;
        }
    },
    canvas: _context.canvasContainer,
    decodeSingle: function(config, resultCallback) {
        if (this.inDecodeSingle) {
            console.warn('* running multiple decodes in serial');
            // force multiple calls to decodeSingle to run in serial, because presently
            // simultaneous running breaks things.
            if (resultCallback) {
                setTimeout(() => this.decodeSingle(config, resultCallback), 300);
            } else {
                return new Promise((resolve) => {
                    setTimeout(() => this.decodeSingle(config, (res) => {
                        resolve(res);
                    }, 300));
                });
            }
            return null;
        }
        this.inDecodeSingle = true;
        config = merge({
            inputStream: {
                type: 'ImageStream',
                sequence: false,
                size: 800,
                src: config.src,
            },
            numOfWorkers: (ENV.development && config.debug) ? 0 : 1,
            locator: {
                halfSample: false,
            },
        }, config);
        // TODO: restructure worker support so that it will work with typescript using worker-loader
        // https://webpack.js.org/loaders/worker-loader/
        if (config.numOfWorkers > 0) {
            config.numOfWorkers = 0;
        }
        // workers require Worker and Blob support presently, so if no Blob or Worker then set
        // workers to 0.
        if (config.numOfWorkers > 0 && (typeof Blob === 'undefined' || typeof Worker === 'undefined')) {
            console.warn('* no Worker and/or Blob support - forcing numOfWorkers to 0');
            config.numOfWorkers = 0;
        }
        return new Promise((resolve, reject) => {
            try {
                this.init(config, () => {
                    Events.once('processed', (result) => {
                        this.inDecodeSingle = false;
                        this.stop();
                        if (resultCallback) {
                            resultCallback.call(null, result);
                        }
                        resolve(result);
                    }, true);
                    start();
                });
            } catch (err) {
                this.inDecodeSingle = false;
                reject(err);
            }
        });
    },
    ImageWrapper: ImageWrapper,
    ImageDebug: ImageDebug,
    ResultCollector: ResultCollector,
    CameraAccess: CameraAccess,
    BarcodeReader,
};
