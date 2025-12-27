#!/bin/bash

# Script to manage TURN server for NodeRTC testing

set -e

COMMAND=${1:-start}

# Check for docker-compose or docker compose
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version &> /dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
else
    echo "Error: Neither 'docker-compose' nor 'docker compose' found"
    echo "Please install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

case "$COMMAND" in
  start)
    echo "Starting TURN server (coturn) via Docker..."
    $DOCKER_COMPOSE up -d
    echo "Waiting for TURN server to be ready..."
    sleep 3
    echo "✓ TURN server is running on localhost:3478"
    echo "  Username: testuser"
    echo "  Password: testpass"
    echo ""
    echo "Alternative credentials:"
    echo "  Username: nodertc"
    echo "  Password: nodertcpass"
    ;;
    
  stop)
    echo "Stopping TURN server..."
    $DOCKER_COMPOSE down
    echo "✓ TURN server stopped"
    ;;
    
  restart)
    echo "Restarting TURN server..."
    $DOCKER_COMPOSE restart
    echo "✓ TURN server restarted"
    ;;
    
  logs)
    echo "TURN server logs:"
    $DOCKER_COMPOSE logs -f coturn
    ;;
    
  status)
    if docker ps | grep -q nodertc-turnserver; then
      echo "✓ TURN server is running"
      docker ps | grep nodertc-turnserver
    else
      echo "✗ TURN server is not running"
      exit 1
    fi
    ;;
    
  test)
    echo "Testing TURN server connectivity..."
    
    # Check if server is running
    if ! docker ps | grep -q nodertc-turnserver; then
      echo "✗ TURN server is not running"
      echo "Start it with: ./turn-server.sh start"
      exit 1
    fi
    
    echo "✓ TURN server is running"
    echo ""
    echo "Running TURN unit tests..."
    npm run test:turn
    echo ""
    echo "Running TURN integration tests..."
    npm run test:turn-integration
    echo ""
    echo "=== All TURN tests complete ==="
    ;;
    
  test-unit)
    echo "Running TURN unit tests only..."
    npm run test:turn
    ;;
    
  test-integration)
    echo "Running TURN integration tests only..."
    npm run test:turn-integration
    ;;
    
  *)
    echo "Usage: $0 {start|stop|restart|logs|status|test|test-unit|test-integration}"
    echo ""
    echo "Commands:"
    echo "  start            - Start the TURN server"
    echo "  stop             - Stop the TURN server"
    echo "  restart          - Restart the TURN server"
    echo "  logs             - Show TURN server logs"
    echo "  status           - Check if TURN server is running"
    echo "  test             - Run all TURN tests (unit + integration)"
    echo "  test-unit        - Run TURN unit tests only"
    echo "  test-integration - Run integration tests only"
    exit 1
    ;;
esac
