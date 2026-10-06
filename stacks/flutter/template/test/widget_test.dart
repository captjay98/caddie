import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forge_flutter_template/main.dart';

/// Real widget tests: the screen talks HTTP to a loopback server started in
/// the test process (no mocks of the widget or the transport). Network
/// completion is yielded through tester.runAsync, the documented way to run
/// real I/O inside the test binding's fake-async zone.
void main() {
  Future<HttpServer> startServer(int status, String body) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      request.response.statusCode = status;
      request.response.headers.contentType = ContentType.json;
      request.response.write(body);
      await request.response.close();
    });
    return server;
  }

  testWidgets('renders tasks fetched from the API', (tester) async {
    final server = await startServer(
      200,
      jsonEncode([
        {'id': 1, 'title': 'prove the emulator journey', 'done': false},
        {'id': 2, 'title': 'close the packet', 'done': true},
      ]),
    );
    addTearDown(server.close);

    await tester.pumpWidget(MaterialApp(
      home: TaskListScreen(apiBase: 'http://127.0.0.1:${server.port}'),
    ));
    // Let the real HTTP round-trip finish on the real event loop, then let
    // the fake-async zone observe the completed future.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await tester.pumpAndSettle();

    expect(find.text('prove the emulator journey'), findsOneWidget);
    expect(find.text('close the packet'), findsOneWidget);
    expect(find.byIcon(Icons.check_box), findsOneWidget);
    expect(find.byIcon(Icons.check_box_outline_blank), findsOneWidget);
  });

  testWidgets('shows the error state with a retry affordance when the API fails', (tester) async {
    final server = await startServer(500, jsonEncode({'error': 'injected'}));
    addTearDown(server.close);

    await tester.pumpWidget(MaterialApp(
      home: TaskListScreen(apiBase: 'http://127.0.0.1:${server.port}'),
    ));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 300)));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('retry-button')), findsOneWidget);
    expect(find.textContaining('API unreachable'), findsOneWidget);
  });
}
