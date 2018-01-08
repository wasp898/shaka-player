/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.text.VttTextParser');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.text.Cue');
goog.require('shaka.text.TextEngine');
goog.require('shaka.util.Error');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.TextParser');



/**
 * @constructor
 * @implements {shakaExtern.TextParser}
 */
shaka.text.VttTextParser = function() { };


/** @override */
shaka.text.VttTextParser.prototype.parseInit = function(data) {
  goog.asserts.assert(false, 'VTT does not have init segments');
};


/**
 * @override
 * @throws {shaka.util.Error}
 */
shaka.text.VttTextParser.prototype.parseMedia = function(data, time) {
  var VttTextParser = shaka.text.VttTextParser;
  // Get the input as a string.  Normalize newlines to \n.
  var str = shaka.util.StringUtils.fromUTF8(data);
  str = str.replace(/\r\n|\r(?=[^\n]|$)/gm, '\n');
  var blocks = str.split(/\n{2,}/m);

  if (!/^WEBVTT($|[ \t\n])/m.test(blocks[0])) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.TEXT,
        shaka.util.Error.Code.INVALID_TEXT_HEADER);
  }

  var offset = time.segmentStart;
  // Parse X-TIMESTAMP-MAP metadata header if it's present to get
  // time offset information.
  // https://tools.ietf.org/html/draft-pantos-http-live-streaming-20#section-3.5
  if (blocks[0].indexOf('X-TIMESTAMP-MAP') >= 0) {
    // 'X-TIMESTAMP-MAP' header is used in HLS to align text with
    // the rest of the media.
    // The header format is 'X-TIMESTAMP-MAP=MPEGTS:n,LOCAL:m'
    // (the attributes can go in any order)
    // where n is MPEG-2 time and m is cue time it maps to.
    // For example 'X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000'
    // means an offset of 10 seconds
    // 900000/MPEG_TIMESCALE - cue time.
    var cueTimeMatch =
        blocks[0].match(/LOCAL:((?:(\d{1,}):)?(\d{2}):(\d{2})\.(\d{3}))/m);

    var mpegTimeMatch = blocks[0].match(/MPEGTS:(\d+)/m);
    if (cueTimeMatch && mpegTimeMatch) {
      var parser = new shaka.util.TextParser(cueTimeMatch[1]);
      var cueTime = shaka.text.VttTextParser.parseTime_(parser);
      var mpegTime = Number(mpegTimeMatch[1]);
      var mpegTimescale = shaka.text.VttTextParser.MPEG_TIMESCALE_;
      // Apple-encoded HLS content uses absolute timestamps, so assume
      // the presence of the map tag means the content uses absolute
      // timestamps.
      offset = time.periodStart + (mpegTime / mpegTimescale - cueTime);
    }
  }

  var ret = [];
  for (var i = 1; i < blocks.length; i++) {
    var lines = blocks[i].split('\n');
    var cue = VttTextParser.parseCue_(lines, offset);
    if (cue)
      ret.push(cue);
  }

  return ret;
};


/**
 * Parses a text block into a Cue object.
 *
 * @param {!Array.<string>} text
 * @param {number} timeOffset
 * @return {shaka.text.Cue}
 * @private
 */
shaka.text.VttTextParser.parseCue_ = function(text, timeOffset) {
  // Skip empty blocks.
  if (text.length == 1 && !text[0])
    return null;

  // Skip comment blocks.
  if (/^NOTE($|[ \t])/.test(text[0]))
    return null;

  // Skip style blocks.
  if (text[0] == 'STYLE')
    return null;

  // TODO(#1188): VTT regions are not parsed yet

  var id = null;
  var index = text[0].indexOf('-->');
  if (index < 0) {
    id = text[0];
    text.splice(0, 1);
  }

  // Parse the times.
  var parser = new shaka.util.TextParser(text[0]);
  var start = shaka.text.VttTextParser.parseTime_(parser);
  var expect = parser.readRegex(/[ \t]+-->[ \t]+/g);
  var end = shaka.text.VttTextParser.parseTime_(parser);

  if (start == null || expect == null || end == null) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.TEXT,
        shaka.util.Error.Code.INVALID_TEXT_CUE);
  }

  start += timeOffset;
  end += timeOffset;

  // Get the payload.
  var payload = text.slice(1).join('\n').trim();

  var cue = new shaka.text.Cue(start, end, payload);

  // Parse optional settings.
  parser.skipWhitespace();
  var word = parser.readWord();
  while (word) {
    if (!shaka.text.VttTextParser.parseSetting(cue, word)) {
      shaka.log.warning('VTT parser encountered an invalid VTT setting: ',
                        word,
                        ' The setting will be ignored.');
    }
    parser.skipWhitespace();
    word = parser.readWord();
  }

  if (id != null)
    cue.id = id;
  return cue;
};


/**
 * Parses a WebVTT setting from the given word.
 *
 * @param {!shaka.text.Cue} cue
 * @param {string} word
 * @return {boolean} True on success.
 */
shaka.text.VttTextParser.parseSetting = function(cue, word) {
  var VttTextParser = shaka.text.VttTextParser;
  var results = null;
  if ((results = /^align:(start|middle|center|end|left|right)$/.exec(word))) {
    VttTextParser.setTextAlign_(cue, results[1]);
  } else if ((results = /^vertical:(lr|rl)$/.exec(word))) {
    VttTextParser.setVerticalWritingDirection_(cue, results[1]);
  } else if ((results = /^size:([\d\.]+)%$/.exec(word))) {
    cue.size = Number(results[1]);
  } else if ((results =
      /^position:([\d\.]+)%(?:,(line-left|line-right|center|start|end))?$/
      .exec(word))) {
    cue.position = Number(results[1]);
    if (results[2]) {
      VttTextParser.setPositionAlign_(cue, results[2]);
    }
  } else {
    return VttTextParser.parsedLineValueAndInterpretation_(cue, word);
  }

  return true;
};


/**
 * @param {!shaka.text.Cue} cue
 * @param {!string} align
 * @private
 */
shaka.text.VttTextParser.setTextAlign_ = function(cue, align) {
  var Cue = shaka.text.Cue;
  if (align == 'middle') {
    cue.textAlign = Cue.textAlign.CENTER;
  } else {
    goog.asserts.assert(align.toUpperCase() in Cue.textAlign,
                        align.toUpperCase() +
                        ' Should be in Cue.textAlign values!');

    cue.textAlign = Cue.textAlign[align.toUpperCase()];
  }
};


/**
 * @param {!shaka.text.Cue} cue
 * @param {!string} align
 * @private
 */
shaka.text.VttTextParser.setPositionAlign_ = function(cue, align) {
  var Cue = shaka.text.Cue;
  if (align == 'line-left' || align == 'start')
    cue.positionAlign = Cue.positionAlign.LEFT;
  else if (align == 'line-right' || align == 'end')
    cue.positionAlign = Cue.positionAlign.RIGHT;
  else
    cue.positionAlign = Cue.positionAlign.CENTER;
};


/**
 * @param {!shaka.text.Cue} cue
 * @param {!string} value
 * @private
 */
shaka.text.VttTextParser.setVerticalWritingDirection_ = function(cue, value) {
  var Cue = shaka.text.Cue;
  if (value == 'lr')
    cue.writingDirection = Cue.writingDirection.VERTICAL_LEFT_TO_RIGHT;
  else
    cue.writingDirection = Cue.writingDirection.VERTICAL_RIGHT_TO_LEFT;
};


/**
 * @param {!shaka.text.Cue} cue
 * @param {!string} word
 * @return {boolean}
 * @private
 */
shaka.text.VttTextParser.parsedLineValueAndInterpretation_ =
    function(cue, word) {
  var Cue = shaka.text.Cue;
  var results = null;
  if ((results = /^line:([\d\.]+)%(?:,(start|end|center))?$/.exec(word))) {
    cue.lineInterpretation = Cue.lineInterpretation.PERCENTAGE;
    cue.line = Number(results[1]);
    if (results[2]) {
      goog.asserts.assert(results[2].toUpperCase() in Cue.lineAlign,
                          results[2].toUpperCase() +
                          ' Should be in Cue.lineAlign values!');
      cue.lineAlign = Cue.lineAlign[results[2].toUpperCase()];
    }
  } else if ((results = /^line:(-?\d+)(?:,(start|end|center))?$/.exec(word))) {
    cue.lineInterpretation = Cue.lineInterpretation.LINE_NUMBER;
    cue.line = Number(results[1]);
    if (results[2]) {
      goog.asserts.assert(results[2].toUpperCase() in Cue.lineAlign,
                          results[2].toUpperCase() +
                          ' Should be in Cue.lineAlign values!');
      cue.lineAlign = Cue.lineAlign[results[2].toUpperCase()];
    }
  } else {
    return false;
  }

  return true;
};


/**
 * Parses a WebVTT time from the given parser.
 *
 * @param {!shaka.util.TextParser} parser
 * @return {?number}
 * @private
 */
shaka.text.VttTextParser.parseTime_ = function(parser) {
  // 00:00.000 or 00:00:00.000 or 0:00:00.000
  var results = parser.readRegex(/(?:(\d{1,}):)?(\d{2}):(\d{2})\.(\d{3})/g);
  if (results == null)
    return null;
  // This capture is optional, but will still be in the array as undefined,
  // default to 0.
  var hours = Number(results[1]) || 0;
  var minutes = Number(results[2]);
  var seconds = Number(results[3]);
  var miliseconds = Number(results[4]);
  if (minutes > 59 || seconds > 59)
    return null;

  return (miliseconds / 1000) + seconds + (minutes * 60) + (hours * 3600);
};


/**
 * @const {number}
 * @private
 */
shaka.text.VttTextParser.MPEG_TIMESCALE_ = 90000;

shaka.text.TextEngine.registerParser(
    'text/vtt',
    shaka.text.VttTextParser);

shaka.text.TextEngine.registerParser(
    'text/vtt; codecs="vtt"',
    shaka.text.VttTextParser);
