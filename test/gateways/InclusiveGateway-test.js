'use strict';

const Code = require('code');
const Lab = require('lab');
const testHelpers = require('../helpers/testHelpers');

const lab = exports.lab = Lab.script();
const expect = Code.expect;
const Bpmn = require('../..');

lab.experiment('InclusiveGateway', () => {
  lab.describe('behavior', () => {
    const processXml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <definitions id="Definitions_1" xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" targetNamespace="http://bpmn.io/schema/bpmn">
      <process id="mainProcess" isExecutable="true">
        <startEvent id="start" />
        <inclusiveGateway id="decisions" default="defaultFlow">
          <extensionElements>
            <camunda:InputOutput>
              <camunda:inputParameter name="takeCondition1">\${variables.condition1}</camunda:inputParameter>
              <camunda:outputParameter name="enteredDecision">Yes</camunda:outputParameter>
            </camunda:InputOutput>
          </extensionElements>
        </inclusiveGateway>
        <endEvent id="end1" />
        <endEvent id="end2" />
        <endEvent id="end3" />
        <sequenceFlow id="flow1" sourceRef="start" targetRef="decisions" />
        <sequenceFlow id="defaultFlow" sourceRef="decisions" targetRef="end2" />
        <sequenceFlow id="condFlow1" sourceRef="decisions" targetRef="end1">
          <conditionExpression xsi:type="tFormalExpression">\${takeCondition1}</conditionExpression>
        </sequenceFlow>
        <sequenceFlow id="condFlow2" sourceRef="decisions" targetRef="end3">
          <conditionExpression xsi:type="tFormalExpression">\${variables.condition2}</conditionExpression>
        </sequenceFlow>
      </process>
    </definitions>`;

    let context;
    lab.beforeEach((done) => {
      testHelpers.getContext(processXml, {
        camunda: require('camunda-bpmn-moddle/resources/camunda')
      }, (err, c) => {
        if (err) return done(err);
        context = c;
        done();
      });
    });

    lab.test('outbound flows are reordered with default flow last', (done) => {
      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      gateway.once('enter', (activity, activityExecution) => {
        expect(gateway.outbound.map((f) => f.id), 'loaded outbound').to.equal(['defaultFlow', 'condFlow1', 'condFlow2']);
        expect(activityExecution.getState().pendingOutbound, 'reordered outbound').to.equal(['condFlow1', 'condFlow2', 'defaultFlow']);
        done();
      });

      gateway.inbound[0].take();
    });

    lab.test('variables and services are passed to conditional flow', (done) => {
      context.variablesAndServices.variables.condition1 = true;

      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      gateway.outbound.find((f) => f.id === 'condFlow1').once('taken', () => {
        done();
      });

      gateway.run();
    });

    lab.test('end returns output in callback', (done) => {
      context.variablesAndServices.variables.condition1 = false;

      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      gateway.once('end', (activity, output) => {
        expect(output).to.equal({
          enteredDecision: 'Yes'
        });
        expect(gateway.outbound[0].taken, gateway.outbound[0].id).to.be.true();
        expect(gateway.outbound[1].taken, gateway.outbound[1].id).to.be.false();
        done();
      });

      gateway.run();
    });

    lab.test('discards default outbound if one outbound was taken', (done) => {
      context.variablesAndServices.variables.condition2 = true;

      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      const discardedFlows = [];
      gateway.outbound.forEach((f) => {
        f.once('discarded', () => {
          discardedFlows.push(f.id);
        });
      });

      gateway.once('leave', () => {
        expect(discardedFlows, 'discarded flows').to.equal(['condFlow1', 'defaultFlow']);
        done();
      });

      gateway.inbound[0].take();
    });

    lab.test('discards default outbound if more than one outbound was taken', (done) => {
      context.variablesAndServices.variables.condition1 = true;
      context.variablesAndServices.variables.condition2 = true;

      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      const discardedFlows = [];
      gateway.outbound.forEach((f) => {
        f.once('discarded', () => {
          discardedFlows.push(f.id);
        });
      });

      gateway.once('leave', () => {
        expect(discardedFlows, 'discarded flows').to.equal(['defaultFlow']);
        done();
      });

      gateway.inbound[0].take();
    });

    lab.test('discards all outbound if inbound was discarded', (done) => {
      const gateway = context.getChildActivityById('decisions');
      gateway.activate();

      const discardedFlows = [];
      gateway.outbound.forEach((f) => {
        f.once('discarded', () => {
          discardedFlows.push(f.id);

          if (gateway.outbound.length === discardedFlows.length) {
            done();
          }
        });
      });

      gateway.on('leave', () => {
        expect(discardedFlows, 'discarded flows').to.equal(['defaultFlow', 'condFlow1', 'condFlow2']);
      });

      gateway.inbound[0].discard();
    });

    lab.describe('resume()', () => {
      lab.test('sets resumed gateway pendingOutbound', (done) => {
        context.variablesAndServices.variables.condition2 = true;

        const gateway = context.getChildActivityById('decisions');

        gateway.on('start', (activity) => {

          gateway.outbound[1].once('discarded', () => {
            activity.stop();

            const state = activity.getState();

            expect(state).to.include({
              discardedOutbound: ['condFlow1'],
              pendingOutbound: ['condFlow2', 'defaultFlow']
            });

            const clonedContext = testHelpers.cloneContext(context);
            const resumedGateway = clonedContext.getChildActivityById('decisions');
            resumedGateway.id += '-resumed';

            resumedGateway.once('enter', (g, resumedActivity) => {
              resumedActivity.stop();
              expect(resumedActivity.getState().pendingOutbound).to.equal(['condFlow2', 'defaultFlow']);
              done();
            });

            resumedGateway.resume(state);
          });
        });

        gateway.activate();
        gateway.run();
      });

      lab.test('discards defaultFlow if other flows were taken', (done) => {
        context.variablesAndServices.variables.condition1 = true;
        context.variablesAndServices.variables.condition2 = true;

        const gateway = context.getChildActivityById('decisions');

        const flowSequence = [];
        gateway.outbound.forEach((f) => {
          f.on('taken', (flow) => {
            flowSequence.push(`taken-${flow.id}`);
          });
          f.on('discarded', (flow) => {
            flowSequence.push(`discarded-${flow.id}`);
          });
        });

        gateway.once('start', (activity) => {
          gateway.outbound[1].once('taken', () => {
            activity.stop();

            const state = activity.getState();

            expect(state).to.include({
              pendingOutbound: ['condFlow2', 'defaultFlow']
            });

            const clonedContext = testHelpers.cloneContext(context);
            const resumedGateway = clonedContext.getChildActivityById('decisions');
            resumedGateway.id += '-resumed';

            resumedGateway.once('end', (g) => {
              const defaultFlow = g.outbound.find((f) => f.isDefault);
              expect(defaultFlow.taken, defaultFlow.id).to.be.true();

              expect(flowSequence).to.equal(['taken-condFlow1', 'taken-condFlow2', 'discarded-defaultFlow']);

              done();
            });

            resumedGateway.resume(state);
          });
        });

        gateway.activate();
        gateway.run();
      });

      lab.test('takes defaultFlow if no other flows were taken', (done) => {
        const gateway = context.getChildActivityById('decisions');

        const flowSequence = [];
        gateway.outbound.forEach((f) => {
          f.on('taken', (flow) => {
            flowSequence.push(`taken-${flow.id}`);
          });
          f.on('discarded', (flow) => {
            flowSequence.push(`discarded-${flow.id}`);
          });
        });

        gateway.once('start', (activity) => {
          gateway.outbound[1].once('discarded', () => {
            activity.stop();

            const state = activity.getState();

            expect(state).to.include({
              discardedOutbound: ['condFlow1'],
              pendingOutbound: ['condFlow2', 'defaultFlow']
            });

            const clonedContext = testHelpers.cloneContext(context);
            const resumedGateway = clonedContext.getChildActivityById('decisions');
            resumedGateway.id += '-resumed';

            resumedGateway.once('end', (g) => {
              const defaultFlow = g.outbound.find((f) => f.isDefault);
              expect(defaultFlow.taken, defaultFlow.id).to.be.true();

              expect(flowSequence).to.equal(['discarded-condFlow1', 'discarded-condFlow2', 'taken-defaultFlow']);

              done();
            });

            resumedGateway.resume(state);
          });
        });

        gateway.activate();
        gateway.run();
      });
    });
  });

  lab.describe('engine', () => {
    lab.test('should support multiple conditional flows, case 1', (done) => {
      const processXml = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="theStart" />
          <inclusiveGateway id="decision" />
          <endEvent id="theEnd1" />
          <endEvent id="theEnd2" />
          <endEvent id="theEnd3" />
          <sequenceFlow id="flow1" sourceRef="theStart" targetRef="decision" />
          <sequenceFlow id="flow2" sourceRef="decision" targetRef="theEnd1" />
          <sequenceFlow id="flow3" sourceRef="decision" targetRef="theEnd2">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 50
            ]]></conditionExpression>
          </sequenceFlow>
          <sequenceFlow id="flow4" sourceRef="decision" targetRef="theEnd3">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 20
            ]]></conditionExpression>
          </sequenceFlow>
        </process>
      </definitions>`;

      const engine = new Bpmn.Engine({
        source: processXml
      });
      engine.execute({
        variables: {
          input: 1
        }
      }, (err, execution) => {
        if (err) return done(err);

        execution.on('end', () => {
          expect(execution.getChildActivityById('theEnd1').taken, 'theEnd1').to.be.true();
          expect(execution.getChildActivityById('theEnd2').taken, 'theEnd2').to.be.true();
          expect(execution.getChildActivityById('theEnd3').taken, 'theEnd3').to.be.true();
          done();
        });
      });
    });

    lab.test('should support the default flow in combination with multiple conditional flows, case condition met', (done) => {
      const processXml = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="theStart" />
          <inclusiveGateway id="decision" default="flow2" />
          <endEvent id="theEnd1" />
          <endEvent id="theEnd2" />
          <endEvent id="theEnd3" />
          <sequenceFlow id="flow1" sourceRef="theStart" targetRef="decision" />
          <sequenceFlow id="flow2" sourceRef="decision" targetRef="theEnd1" />
          <sequenceFlow id="flow3" sourceRef="decision" targetRef="theEnd2">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 50
            ]]></conditionExpression>
          </sequenceFlow>
          <sequenceFlow id="flow4" sourceRef="decision" targetRef="theEnd3">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 20
            ]]></conditionExpression>
          </sequenceFlow>
        </process>
      </definitions>`;

      const engine = new Bpmn.Engine({
        source: processXml
      });
      engine.execute({
        variables: {
          input: 50
        }
      }, (err, execution) => {
        if (err) return done(err);

        execution.once('end', () => {
          expect(execution.getChildActivityById('theEnd1').taken, 'theEnd1').to.be.false();
          expect(execution.getChildActivityById('theEnd2').taken, 'theEnd2').to.be.true();
          expect(execution.getChildActivityById('theEnd3').taken, 'theEnd3').to.be.false();

          testHelpers.expectNoLingeringListenersOnEngine(engine);

          done();
        });
      });
    });

    lab.test('should support the default flow in combination with multiple conditional flows, case no conditions met', (done) => {
      const processXml = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="theStart" />
          <inclusiveGateway id="decision" default="flow2" />
          <endEvent id="theEnd1" />
          <endEvent id="theEnd2" />
          <endEvent id="theEnd3" />
          <sequenceFlow id="flow1" sourceRef="theStart" targetRef="decision" />
          <sequenceFlow id="flow2" sourceRef="decision" targetRef="theEnd1" />
          <sequenceFlow id="flow3" sourceRef="decision" targetRef="theEnd2">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 50
            ]]></conditionExpression>
          </sequenceFlow>
          <sequenceFlow id="flow4" sourceRef="decision" targetRef="theEnd3">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 20
            ]]></conditionExpression>
          </sequenceFlow>
        </process>
      </definitions>`;

      const engine = new Bpmn.Engine({
        source: processXml
      });
      engine.execute({
        variables: {
          input: 60
        }
      }, (err, execution) => {
        if (err) return done(err);

        execution.once('end', () => {
          expect(execution.getChildActivityById('theEnd1').taken, 'theEnd1').to.be.true();
          expect(execution.getChildActivityById('theEnd2').taken, 'theEnd2').to.be.false();
          expect(execution.getChildActivityById('theEnd3').taken, 'theEnd3').to.be.false();

          testHelpers.expectNoLingeringListenersOnEngine(engine);

          done();
        });
      });
    });

    lab.test('emits error when no conditional flow is taken', (done) => {
      const definitionXml = `
      <?xml version="1.0" encoding="UTF-8"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <process id="theProcess" isExecutable="true">
          <startEvent id="theStart" />
          <inclusiveGateway id="decision" />
          <endEvent id="theEnd1" />
          <endEvent id="theEnd2" />
          <sequenceFlow id="flow1" sourceRef="theStart" targetRef="decision" />
          <sequenceFlow id="flow2" sourceRef="decision" targetRef="theEnd1">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 50
            ]]></conditionExpression>
          </sequenceFlow>
          <sequenceFlow id="flow3" sourceRef="decision" targetRef="theEnd2">
            <conditionExpression xsi:type="tFormalExpression" language="JavaScript"><![CDATA[
            this.variables.input <= 20
            ]]></conditionExpression>
          </sequenceFlow>
        </process>
      </definitions>`;

      const engine = new Bpmn.Engine({
        source: definitionXml
      });
      engine.once('error', (err, gateway) => {
        expect(err).to.be.an.error(/no conditional flow/i);
        expect(gateway).to.include({
          id: 'decision'
        });

        testHelpers.expectNoLingeringListenersOnEngine(engine);

        done();
      });

      engine.execute({
        variables: {
          input: 61
        }
      }, (err) => {
        if (err) return done(err);
      });
    });
  });
});
