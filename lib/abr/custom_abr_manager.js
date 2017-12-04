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

goog.provide('shaka.abr.CustomAbrManager');

goog.require('goog.asserts');
goog.require('shaka.abr.EwmaBandwidthEstimator');
goog.require('shaka.log');
goog.require('shaka.util.Error');
goog.require('shaka.util.StreamUtils');



/**
 * <p>
 * This defines the default ABR manager for the Player.  An instance of this
 * class is used when no ABR manager is given.
 * </p>
 * <p>
 * The behavior of this class is to take throughput samples using
 * segmentDownloaded to estimate the current network bandwidth.  Then it will
 * use that to choose the streams that best fit the current bandwidth.  It will
 * always pick the highest bandwidth variant it thinks can be played.
 * </p>
 * <p>
 * After initial choices are made, this class will call switchCallback() when
 * there is a better choice.  switchCallback() will not be called more than once
 * per ({@link shaka.abr.CustomAbrManager.SWITCH_INTERVAL_MS}).
 * </p>
 *
 * @constructor
 * @struct
 * @implements {shakaExtern.AbrManager}
 * @export
 */
shaka.abr.CustomAbrManager = function() {
  /** @private {?shakaExtern.AbrManager.SwitchCallback} */
  this.switch_ = null;

  /** @private {boolean} */
  this.enabled_ = false;

  /** @private {shaka.abr.EwmaBandwidthEstimator} */
  this.bandwidthEstimator_ = new shaka.abr.EwmaBandwidthEstimator();

  /**
   * A filtered list of Variants to choose from.
   * @private {!Array.<!shakaExtern.Variant>}
   */
  this.variants_ = [];

  /** @private {boolean} */
  this.startupComplete_ = false;

  /**
   * The last wall-clock time, in milliseconds, when streams were chosen.
   *
   * @private {?number}
   */
  this.lastTimeChosenMs_ = null;

  /** @private {?shakaExtern.AbrConfiguration} */
  this.config_ = null;

  /** @private {?shaka.media.StreamingEngine.PlayerInterface} */
  this.playerInterface_ = null;

  /** @private {shaka.media.StreamingEngine} */
  this.streamingEngine_ = null;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.stop = function() {
  this.switch_ = null;
  this.enabled_ = false;
  this.variants_ = [];
  this.lastTimeChosenMs_ = null;
  this.playerInterface_ = null;
  this.streamingEngine_ = null;

  // Don't reset |startupComplete_|: if we've left the startup interval then we
  // can start using bandwidth estimates right away if init() is called again.
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.init = function(switchCallback) {
  this.switch_ = switchCallback;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.chooseVariant = function() {
  // Alias.
  var CustomAbrManager = shaka.abr.CustomAbrManager;

  // Get sorted Variants.
  var sortedVariants = CustomAbrManager.filterAndSortVariants_(
      this.config_.restrictions, this.variants_);
  var currentBandwidth = this.bandwidthEstimator_.getBandwidthEstimate(
      this.config_.defaultBandwidthEstimate);

  if (this.variants_.length && !sortedVariants.length) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.RESTRICTIONS_CANNOT_BE_MET);
  }

  // Start by assuming that we will use the first Stream.
  var chosen = sortedVariants[0] || null;

  for (var i = 0; i < sortedVariants.length; ++i) {
    var variant = sortedVariants[i];
    var nextVariant = sortedVariants[i + 1] || {bandwidth: Infinity};

    var minBandwidth = variant.bandwidth /
                       this.config_.bandwidthDowngradeTarget;
    var maxBandwidth = nextVariant.bandwidth /
                       this.config_.bandwidthUpgradeTarget;
    shaka.log.v2('Bandwidth ranges:',
                 (variant.bandwidth / 1e6).toFixed(3),
                 (minBandwidth / 1e6).toFixed(3),
                 (maxBandwidth / 1e6).toFixed(3));

    if (currentBandwidth >= minBandwidth && currentBandwidth <= maxBandwidth)
      chosen = variant;
  }

  this.lastTimeChosenMs_ = Date.now();
  return chosen;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.enable = function() {
  this.enabled_ = true;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.disable = function() {
  this.enabled_ = false;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.segmentDownloaded = function(
    deltaTimeMs, numBytes) {
  shaka.log.v2('Segment downloaded:',
               'deltaTimeMs=' + deltaTimeMs,
               'numBytes=' + numBytes,
               'lastTimeChosenMs=' + this.lastTimeChosenMs_,
               'enabled=' + this.enabled_);
  goog.asserts.assert(deltaTimeMs >= 0, 'expected a non-negative duration');
  this.bandwidthEstimator_.sample(deltaTimeMs, numBytes);

  if ((this.lastTimeChosenMs_ != null) && this.enabled_)
    this.suggestStreams_();
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.getBandwidthEstimate = function() {
  return this.bandwidthEstimator_.getBandwidthEstimate(
      this.config_.defaultBandwidthEstimate);
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.setVariants = function(variants) {
  this.variants_ = variants;
};


/**
 * @override
 * @export
 */
shaka.abr.CustomAbrManager.prototype.configure = function(config) {
  this.config_ = config;
};


/**
 * Calls switch_() with which Streams to switch to.
 *
 * @private
 */
shaka.abr.CustomAbrManager.prototype.suggestStreams_ = function() {
  shaka.log.v2('Suggesting Streams...');
  goog.asserts.assert(this.lastTimeChosenMs_ != null,
                      'lastTimeChosenMs_ should not be null');

  if (!this.startupComplete_) {
    // Check if we've got enough data yet.
    if (!this.bandwidthEstimator_.hasGoodEstimate()) {
      shaka.log.v2('Still waiting for a good estimate...');
      return;
    }
    this.startupComplete_ = true;
  } else {
    // Check if we've left the switch interval.
    var now = Date.now();
    var delta = now - this.lastTimeChosenMs_;
    if (delta < this.config_.switchInterval * 1000) {
      shaka.log.v2('Still within switch interval...');
      return;
    }
  }

  // Choose whether to clear the buffer when switching variants
  var opt_clearBuffer = false;
  // Choose the amount of buffer to keep when clearing, optionally
  var opt_safeMargin = 0;

  for (mediaState in this.streamingEngine_.mediaStates_) {
    // We only care about the video buffer state
    if (mediaState == 'video') {
      var playheadTime =
          this.streamingEngine_.playerInterface_.playhead.getTime();
      shaka.log.debug('Playhead ' + playheadTime);
      var bufferedAhead =
          this.playerInterface_.mediaSourceEngine.bufferedAheadOf(
          mediaState, playheadTime);
      shaka.log.debug('buffered ' + mediaState + ' ' + bufferedAhead);
      opt_safeMargin = bufferedAhead / 2;
      opt_clearBuffer = true;
      break;
    }
  }

  // Choose the variant to switch to
  var chosenVariant = this.chooseVariant();
  var bandwidthEstimate = this.bandwidthEstimator_.getBandwidthEstimate(
      this.config_.defaultBandwidthEstimate);
  var currentBandwidthKbps = Math.round(bandwidthEstimate / 1000.0);
  shaka.log.debug(
      'Calling switch_(), bandwidth=' + currentBandwidthKbps + ' kbps');
  // If any of these chosen streams are already chosen, Player will filter them
  // out before passing the choices on to StreamingEngine.
  this.switch_(chosenVariant, opt_clearBuffer, opt_safeMargin);
};


/**
 * @param {shakaExtern.Restrictions} restrictions
 * @param {!Array.<shakaExtern.Variant>} variants
 * @return {!Array.<shakaExtern.Variant>} variants filtered according to
 *   |restrictions| and sorted in ascending order of bandwidth.
 * @private
 */
shaka.abr.CustomAbrManager.filterAndSortVariants_ = function(
    restrictions, variants) {
  return variants
      .filter(function(variant) {
        return shaka.util.StreamUtils.meetsRestrictions(
            variant, restrictions,
            /* maxHwRes */ {width: Infinity, height: Infinity});
      })
      .sort(function(v1, v2) {
        return v1.bandwidth - v2.bandwidth;
      });
};


/**
 * Provide an interface of the streaming engine in order to get access
 * to the buffer state and the playhead state.
 * @param {shaka.media.StreamingEngine} streamingEngine
 */
shaka.abr.CustomAbrManager.prototype.supplyStreamingEngine = function(
    streamingEngine) {
  this.streamingEngine_ = streamingEngine;
  this.playerInterface_ = streamingEngine.playerInterface_;
};
