import 'html-midi-player';
import React, { FC, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { WorkHeader } from '../components/WorkHeader';
import { Button, Checkbox, Dropdown, Option, Textarea } from '@fluentui/react-components';
import { Labeled } from '../components/Labeled';
import { ValuedSlider } from '../components/ValuedSlider';
import { useTranslation } from 'react-i18next';
import commonStore, { ModelStatus } from '../stores/commonStore';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { toast } from 'react-toastify';
import { DialogButton } from '../components/DialogButton';
import { ToolTipButton } from '../components/ToolTipButton';
import { ArrowSync20Regular, Save28Regular } from '@fluentui/react-icons';
import { PlayerElement, VisualizerElement } from 'html-midi-player';
import * as mm from '@magenta/music/esm/core.js';
import { NoteSequence } from '@magenta/music/esm/protobuf.js';
import { defaultCompositionPrompt } from './defaultConfigs';
import {
  CloseMidiPort,
  FileExists,
  OpenFileFolder,
  OpenMidiPort,
  OpenSaveFileDialogBytes
} from '../../wailsjs/go/backend_golang/App';
import { getServerRoot, getSoundFont, toastWithButton } from '../utils';
import { CompositionParams } from '../types/composition';
import { useMediaQuery } from 'usehooks-ts';
import { AudiotrackButton } from './AudiotrackManager/AudiotrackButton';

let compositionSseController: AbortController | null = null;

const CompositionPanel: FC = observer(() => {
  const { t } = useTranslation();
  const mq = useMediaQuery('(min-width: 640px)');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const port = commonStore.getCurrentModelConfig().apiParameters.apiPort;
  const visualizerRef = useRef<VisualizerElement>(null);
  const playerRef = useRef<PlayerElement>(null);

  const scrollToBottom = () => {
    if (inputRef.current)
      inputRef.current.scrollTop = inputRef.current.scrollHeight;
  };

  const params = commonStore.compositionParams;
  const setParams = (newParams: Partial<CompositionParams>) => {
    commonStore.setCompositionParams({
      ...commonStore.compositionParams,
      ...newParams
    });
  };

  const setPrompt = (prompt: string) => {
    setParams({
      prompt
    });
    if (!commonStore.compositionGenerating)
      generateNs(false);
  };

  const updateNs = (ns: NoteSequence | null) => {
    if (playerRef.current) {
      playerRef.current.noteSequence = ns;
      playerRef.current.reload();
    }
    if (visualizerRef.current) {
      visualizerRef.current.noteSequence = ns;
      visualizerRef.current.reload();
    }
  };

  const setSoundFont = async () => {
    if (playerRef.current) {
      playerRef.current.soundFont = await getSoundFont();
    }
  };

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = '100%';
      inputRef.current.style.maxHeight = '100%';
    }
    scrollToBottom();

    if (playerRef.current && visualizerRef.current) {
      playerRef.current.addVisualizer(visualizerRef.current);
      playerRef.current.addEventListener('start', () => {
        visualizerRef.current?.reload();
      });
      setSoundFont().then(() => {
        updateNs(params.ns);
      });

      const button = playerRef.current.shadowRoot?.querySelector('.controls .play') as HTMLElement | null;
      if (button)
        button.style.background = '#f2f5f6';
    }
  }, []);

  useEffect(() => {
    if (!(commonStore.activeMidiDeviceIndex in commonStore.midiPorts)) {
      commonStore.setActiveMidiDeviceIndex(-1);
      CloseMidiPort();
    }
  }, [commonStore.midiPorts]);

  const generateNs = (autoPlay: boolean) => {
    fetch(getServerRoot(port) + '/text-to-midi', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        'text': commonStore.compositionParams.prompt.replaceAll(/<pad>|<start>|<end>/g, '').replaceAll('  ', ' ').trim()
      })
    }).then(r => {
      r.arrayBuffer().then(midi => {
        const ns = mm.midiToSequenceProto(midi);
        setParams({
          midi,
          ns
        });
        updateNs(ns);
        if (autoPlay) {
          setTimeout(() => {
            playerRef.current?.start();
          });
        }
      });
    });
  };

  const onSubmit = (prompt: string) => {
    commonStore.setCompositionSubmittedPrompt(prompt);

    if (commonStore.status.status === ModelStatus.Offline && !commonStore.settings.apiUrl && commonStore.platform !== 'web') {
      toast(t('Please click the button in the top right corner to start the model'), { type: 'warning' });
      commonStore.setCompositionGenerating(false);
      return;
    }

    let answer = '';
    compositionSseController = new AbortController();
    fetchEventSource( // https://api.openai.com/v1/completions || http://127.0.0.1:${port}/v1/completions
      getServerRoot(port) + '/v1/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${commonStore.settings.apiKey}`
        },
        body: JSON.stringify({
          prompt,
          stream: true,
          model: commonStore.settings.apiCompletionModelName, // 'text-davinci-003'
          max_tokens: params.maxResponseToken,
          temperature: params.temperature,
          top_p: params.topP
        }),
        signal: compositionSseController?.signal,
        onmessage(e) {
          scrollToBottom();
          if (e.data.trim() === '[DONE]') {
            commonStore.setCompositionGenerating(false);
            generateNs(commonStore.compositionParams.autoPlay);
            return;
          }
          let data;
          try {
            data = JSON.parse(e.data);
          } catch (error) {
            console.debug('json error', error);
            return;
          }
          if (data.model)
            commonStore.setLastModelName(data.model);
          if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
            answer += data.choices[0]?.text || data.choices[0]?.delta?.content || '';
            setPrompt(prompt + answer.replace(/\s+$/, ''));
          }
        },
        async onopen(response) {
          if (response.status !== 200) {
            toast(response.statusText + '\n' + (await response.text()), {
              type: 'error'
            });
          }
        },
        onclose() {
          console.log('Connection closed');
        },
        onerror(err) {
          err = err.message || err;
          if (err && !err.includes('ReadableStreamDefaultReader'))
            toast(err, {
              type: 'error'
            });
          commonStore.setCompositionGenerating(false);
          throw err;
        }
      });
  };

  return (
    <div className="flex flex-col gap-2 overflow-hidden grow">
      <div className="flex flex-col sm:flex-row gap-2 overflow-hidden grow">
        <Textarea
          ref={inputRef}
          className="grow"
          value={params.prompt}
          onChange={(e) => {
            commonStore.setCompositionSubmittedPrompt(e.target.value);
            setPrompt(e.target.value);
          }}
        />
        <div className="flex flex-col gap-1 max-h-48 sm:max-w-sm sm:max-h-full">
          <div className="flex flex-col gap-1 grow overflow-x-hidden overflow-y-auto p-1">
            <Labeled flex breakline label={t('Max Response Token')}
              desc={t('By default, the maximum number of tokens that can be answered in a single response, it can be changed by the user by specifying API parameters.')}
              content={
                <ValuedSlider value={params.maxResponseToken} min={100} max={4100}
                  step={100}
                  input
                  onChange={(e, data) => {
                    setParams({
                      maxResponseToken: data.value
                    });
                  }} />
              } />
            <Labeled flex breakline label={t('Temperature')}
              desc={t('Sampling temperature, it\'s like giving alcohol to a model, the higher the stronger the randomness and creativity, while the lower, the more focused and deterministic it will be.')}
              content={
                <ValuedSlider value={params.temperature} min={0} max={2} step={0.1}
                  input
                  onChange={(e, data) => {
                    setParams({
                      temperature: data.value
                    });
                  }} />
              } />
            <Labeled flex breakline label={t('Top_P')}
              desc={t('Just like feeding sedatives to the model. Consider the results of the top n% probability mass, 0.1 considers the top 10%, with higher quality but more conservative, 1 considers all results, with lower quality but more diverse.')}
              content={
                <ValuedSlider value={params.topP} min={0} max={1} step={0.1} input
                  onChange={(e, data) => {
                    setParams({
                      topP: data.value
                    });
                  }} />
              } />
            <div className="grow" />
            <Checkbox className="select-none"
              size="large" label={t('Use Local Sound Font')} checked={params.useLocalSoundFont}
              onChange={async (_, data) => {
                if (data.checked) {
                  if (!await FileExists('assets/sound-font/accordion/instrument.json')) {
                    toast(t('Failed to load local sound font, please check if the files exist - assets/sound-font'),
                      { type: 'warning' });
                    return;
                  }
                }
                setParams({
                  useLocalSoundFont: data.checked as boolean
                });
                setSoundFont();
              }} />
            <Checkbox className="select-none"
              size="large" label={t('Auto Play At The End')} checked={params.autoPlay} onChange={(_, data) => {
              setParams({
                autoPlay: data.checked as boolean
              });
            }} />
            {commonStore.platform !== 'web' &&
              <Labeled flex breakline label={t('MIDI Input')}
                desc={t('Select the MIDI input device to be used.')}
                content={
                  <div className="flex flex-col gap-1">
                    <Dropdown style={{ minWidth: 0 }}
                      value={(commonStore.activeMidiDeviceIndex === -1 || !(commonStore.activeMidiDeviceIndex in commonStore.midiPorts))
                        ? t('None')!
                        : commonStore.midiPorts[commonStore.activeMidiDeviceIndex].name}
                      selectedOptions={[commonStore.activeMidiDeviceIndex.toString()]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          const index = Number(data.optionValue);
                          let action = (index === -1)
                            ? () => CloseMidiPort()
                            : () => OpenMidiPort(index);
                          action().then(() => {
                            commonStore.setActiveMidiDeviceIndex(index);
                          }).catch((e) => {
                            toast(t('Error') + ' - ' + (e.message || e), { type: 'error', autoClose: 2500 });
                          });
                        }
                      }}>
                      <Option value={'-1'}>{t('None')!}</Option>
                      {commonStore.midiPorts.map((p, i) =>
                        <Option key={i} value={i.toString()}>{p.name}</Option>)
                      }
                    </Dropdown>
                    <AudiotrackButton setPrompt={setPrompt} />
                  </div>
                } />
            }
          </div>
          <div className="flex justify-between gap-2">
            <ToolTipButton desc={t('Regenerate')} icon={<ArrowSync20Regular />} onClick={() => {
              compositionSseController?.abort();
              commonStore.setCompositionGenerating(true);
              setPrompt(commonStore.compositionSubmittedPrompt);
              onSubmit(commonStore.compositionSubmittedPrompt);
            }} />
            <DialogButton className="grow" text={t('Reset')} title={t('Reset')}
              contentText={t('Are you sure you want to reset this page? It cannot be undone.')}
              onConfirm={() => {
                commonStore.setCompositionSubmittedPrompt(defaultCompositionPrompt);
                setPrompt(defaultCompositionPrompt);
              }} />
            <Button className="grow" appearance="primary" onClick={() => {
              if (commonStore.compositionGenerating) {
                compositionSseController?.abort();
                commonStore.setCompositionGenerating(false);
                generateNs(params.autoPlay);
              } else {
                commonStore.setCompositionGenerating(true);
                onSubmit(params.prompt);
              }
            }}>{!commonStore.compositionGenerating ? t('Generate') : t('Stop')}</Button>
          </div>
        </div>
      </div>
      <div className="flex flex-col">
        <div className="ml-auto mr-auto">
          <midi-visualizer
            ref={visualizerRef}
            type="waterfall"
          />
        </div>
        <div className="flex">
          <midi-player
            ref={playerRef}
            style={{ width: '100%' }}
          />
          <Button icon={<Save28Regular />} size={mq ? 'large' : 'medium'} appearance={mq ? 'secondary' : 'subtle'}
            onClick={() => {
              if (params.midi) {
                OpenSaveFileDialogBytes('*.mid', 'music.mid', Array.from(new Uint8Array(params.midi))).then((path) => {
                  if (path)
                    toastWithButton(t('File Saved'), t('Open'), () => {
                      OpenFileFolder(path, false);
                    });
                }).catch((e) => {
                  toast(t('Error') + ' - ' + (e.message || e), { type: 'error', autoClose: 2500 });
                });
              } else {
                toast(t('No File to save'), { type: 'warning', autoClose: 1500 });
              }
            }}
          >
            {mq ? t('Save') : ''}
          </Button>
        </div>
      </div>
    </div>
  );
});

const Composition: FC = observer(() => {
  return (
    <div className="flex flex-col gap-1 p-2 h-full overflow-hidden">
      <WorkHeader />
      <CompositionPanel />
    </div>
  );
});

export default Composition;
